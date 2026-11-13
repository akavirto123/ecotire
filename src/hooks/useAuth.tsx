import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { supabase } from '@/lib/supabase';
import { setLocalOnly } from '@/lib/db';

/** pessoal = motorista comum; frota = gestor ou motorista de empresa (ESG) */
export type Usage = 'personal' | 'fleet';
export type AppUser = { id: string; email: string; name: string; demo: boolean; usage: Usage };

type AuthCtx = {
  user: AppUser | null;
  loading: boolean;
  /** true quando o Supabase está configurado (.env preenchido) */
  hasBackend: boolean;
  signIn: (email: string, password: string) => Promise<string | null>;
  signUp: (name: string, email: string, password: string, usage: Usage) => Promise<{ error: string | null; needsConfirmation: boolean }>;
  resetPassword: (email: string) => Promise<string | null>;
  enterDemo: (name: string, usage: Usage) => void;
  setUsage: (u: Usage) => Promise<void>;
  signOut: () => Promise<void>;
};

const Ctx = createContext<AuthCtx | null>(null);
const DEMO_KEY = 'ecotire:demo-user';

const ERRORS: [RegExp, string][] = [
  [/invalid login credentials/i, 'E-mail ou senha incorretos.'],
  [/email not confirmed/i, 'Confirme seu e-mail pelo link que enviamos antes de entrar.'],
  [/already registered|already been registered/i, 'Este e-mail já tem conta. Use "Entrar".'],
  [/password should be at least/i, 'A senha precisa ter pelo menos 6 caracteres.'],
  [/rate limit|too many/i, 'Muitas tentativas. Aguarde um minuto e tente de novo.'],
  [/failed to fetch|network/i, 'Sem conexão com o servidor. Verifique a internet.'],
  [/email address .* is invalid|invalid email|unable to validate email/i, 'O servidor recusou esse e-mail. Tente outro endereço (ex.: nome@gmail.com) ou use "Testar sem conta".'],
  [/email rate limit|over_email_send_rate_limit/i, 'O servidor gratuito só envia poucos e-mails por hora. Tente daqui a pouco ou use "Testar sem conta".'],
  [/signups? not allowed|signup is disabled/i, 'Cadastro de novas contas está desligado no Supabase.'],
  [/weak password|password is too weak|pwned/i, 'Senha fraca. Use pelo menos 8 caracteres misturando letras e números.'],
];
const translate = (msg: string) => ERRORS.find(([re]) => re.test(msg))?.[1] ?? msg;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AppUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let savedDemo: AppUser | null = null;
    try {
      const saved = localStorage.getItem(DEMO_KEY);
      if (saved) {
        const u = JSON.parse(saved) as Partial<AppUser>;
        savedDemo = { ...(u as AppUser), usage: u.usage === 'fleet' ? 'fleet' : 'personal' };
      }
    } catch {
      /* ignora */
    }
    if (!supabase || savedDemo) {
      setLocalOnly(!!supabase);
      setUser(savedDemo);
      setLoading(false);
      return;
    }
    const toUser = (u: { id: string; email?: string; user_metadata?: Record<string, unknown> } | null | undefined): AppUser | null =>
      u ? { id: u.id, email: u.email ?? '', name: (u.user_metadata?.name as string) || (u.email ?? '').split('@')[0], demo: false, usage: u.user_metadata?.usage === 'fleet' ? 'fleet' : 'personal' } : null;
    supabase.auth.getSession().then(({ data }) => {
      setUser(toUser(data.session?.user));
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => setUser(toUser(session?.user)));
    return () => sub.subscription.unsubscribe();
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    if (!supabase) return 'Banco de dados não configurado.';
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return error ? translate(error.message) : null;
  }, []);

  const signUp = useCallback(async (name: string, email: string, password: string, usage: Usage) => {
    if (!supabase) return { error: 'Banco de dados não configurado.', needsConfirmation: false };
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { name, usage }, emailRedirectTo: window.location.origin + window.location.pathname },
    });
    return { error: error ? translate(error.message) : null, needsConfirmation: !error && !data.session };
  }, []);

  const resetPassword = useCallback(async (email: string) => {
    if (!supabase) return 'Banco de dados não configurado.';
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin + window.location.pathname });
    return error ? translate(error.message) : null;
  }, []);

  const enterDemo = useCallback((name: string, usage: Usage) => {
    const demo: AppUser = { id: 'demo', email: 'demo@local', name: name.trim() || 'Visitante', demo: true, usage };
    setLocalOnly(!!supabase);
    try {
      localStorage.setItem(DEMO_KEY, JSON.stringify(demo));
    } catch {
      /* ignora */
    }
    setUser(demo);
  }, []);

  const setUsage = useCallback(async (usage: Usage) => {
    if (supabase && !user?.demo) await supabase.auth.updateUser({ data: { usage } });
    setUser((u) => {
      if (!u) return u;
      const next = { ...u, usage };
      if (u.demo) {
        try {
          localStorage.setItem(DEMO_KEY, JSON.stringify(next));
        } catch {
          /* ignora */
        }
      }
      return next;
    });
  }, [user]);

  const signOut = useCallback(async () => {
    try {
      localStorage.removeItem(DEMO_KEY);
    } catch {
      /* ignora */
    }
    const wasDemo = user?.demo;
    setLocalOnly(false);
    if (supabase && !wasDemo) await supabase.auth.signOut();
    setUser(null);
  }, [user]);

  const value = useMemo(
    () => ({ user, loading, hasBackend: !!supabase, signIn, signUp, resetPassword, enterDemo, setUsage, signOut }),
    [user, loading, signIn, signUp, resetPassword, enterDemo, setUsage, signOut],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth fora do AuthProvider');
  return v;
}
