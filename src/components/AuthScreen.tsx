import { ArrowRight, Building2, Loader2, ShieldCheck, User, Volume2, Waypoints } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { AirField } from '@/components/AirField';
import { Tire3D } from '@/components/Tire3D';
import { useAuth, type Usage } from '@/hooks/useAuth';
import { useTheme } from '@/lib/theme';

type Mode = 'signin' | 'signup' | 'reset';

export function AuthScreen() {
  const { hasBackend, signIn, signUp, resetPassword, enterDemo } = useAuth();
  const theme = useTheme();
  const [mode, setMode] = useState<Mode>('signin');
  const [name, setName] = useState('');
  const [usage, setUsageChoice] = useState<Usage>('personal');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setInfo(null);
    if (!hasBackend) return enterDemo(name, usage);
    setBusy(true);
    if (mode === 'signin') {
      setError(await signIn(email.trim(), password));
    } else if (mode === 'signup') {
      const r = await signUp(name.trim(), email.trim(), password, usage);
      setError(r.error);
      if (r.needsConfirmation) {
        setInfo('Conta criada. Abra o link de confirmação que enviamos para o seu e-mail e depois entre.');
        setMode('signin');
      }
    } else {
      const err = await resetPassword(email.trim());
      setError(err);
      if (!err) setInfo('Enviamos um link para redefinir a senha. Confira seu e-mail.');
    }
    setBusy(false);
  };

  const titles: Record<Mode, string> = { signin: 'Entrar', signup: 'Criar conta', reset: 'Recuperar senha' };

  return (
    <div className="relative min-h-full overflow-hidden bg-ink">

      <AirField className="pointer-events-none absolute inset-0 h-full w-full" />
      <div className="relative mx-auto grid min-h-screen max-w-6xl items-center gap-6 px-5 py-10 lg:grid-cols-[1.15fr_0.85fr]">
        <section className="relative">
          <div className="emboss absolute -left-3 top-16 text-[clamp(5rem,15vw,11rem)]" aria-hidden="true">ECO<br />TIRE</div>
          <div className="relative">
            <div className="flex items-center gap-3">
              <img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" className="h-11 w-11" />
              <div>
                <div className="font-display text-xl font-extrabold">ECO<span className="text-eco">TIRE</span></div>
                <div className="text-xs tracking-[0.2em] text-mist" style={{ fontStretch: '125%' }}>PM2.5 / PM10</div>
              </div>
            </div>
            <Tire3D intensity={0.35} speedKmh={45} theme={theme} className="mt-4 h-64 w-full max-w-xl sm:h-80" />
            <h1 className="max-w-xl font-display text-4xl font-extrabold leading-[1.02] sm:text-5xl">Cada freada deixa borracha no ar.</h1>
            <p className="mt-4 max-w-lg text-mist">
              O EcoTire estima, de forma aproximada e em tempo real, o material particulado que o desgaste dos pneus solta, e
              avisa antes de você passar por escolas, hospitais e trechos de piso irregular.
            </p>
            <div className="tread mt-6 max-w-xl" aria-hidden="true" />
            <ul className="mt-4 grid max-w-xl gap-2 text-sm text-mist sm:grid-cols-3">
              <li className="flex items-center gap-2"><Waypoints className="h-4 w-4 text-eco" /> Rota de menor impacto</li>
              <li className="flex items-center gap-2"><Volume2 className="h-4 w-4 text-eco" /> Alerta por voz</li>
              <li className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-eco" /> Pneu que dura mais</li>
            </ul>
          </div>
        </section>

        <form onSubmit={submit} className="glass rise rounded-3xl p-6 sm:p-8">
          <h2 className="font-display text-2xl font-semibold">{hasBackend ? titles[mode] : 'Modo demonstração'}</h2>
          <p className="mt-1 text-sm text-mist">
            {!hasBackend
              ? 'O banco de dados ainda não foi configurado (.env). Você pode testar tudo agora: os dados ficam salvos só neste navegador.'
              : mode === 'signin'
                ? 'Acesse seu histórico de viagens e sua garagem.'
                : mode === 'signup'
                  ? 'Leva menos de um minuto.'
                  : 'Informe o e-mail da conta.'}
          </p>

          <div className="mt-6 space-y-4">
            {(!hasBackend || mode === 'signup') && (
              <fieldset>
                <legend className="label">Como você vai usar o EcoTire?</legend>
                <div className="grid grid-cols-2 gap-2">
                  {([
                    { id: 'personal', icon: User, title: 'Uso pessoal', desc: 'Meu carro, meu ranking com amigos' },
                    { id: 'fleet', icon: Building2, title: 'Frota', desc: 'Empresa, vários motoristas, relatório ESG' },
                  ] as const).map((o) => (
                    <label key={o.id} className={`cursor-pointer rounded-xl border p-3 transition ${usage === o.id ? 'border-eco bg-eco/10' : 'border-line hover:bg-white/5'}`}>
                      <input type="radio" name="usage" value={o.id} checked={usage === o.id} onChange={() => setUsageChoice(o.id)} className="sr-only" />
                      <o.icon className={`h-5 w-5 ${usage === o.id ? 'text-eco' : 'text-mist'}`} />
                      <div className="mt-1.5 text-sm font-semibold">{o.title}</div>
                      <div className="text-xs leading-snug text-mist">{o.desc}</div>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            {(!hasBackend || mode === 'signup') && (
              <div>
                <label className="label" htmlFor="name">Seu nome</label>
                <input id="name" className="field" value={name} onChange={(e) => setName(e.target.value)} required={hasBackend} autoComplete="name" placeholder="Como quer ser chamado" />
              </div>
            )}
            {hasBackend && (
              <div>
                <label className="label" htmlFor="email">E-mail</label>
                <input id="email" type="email" className="field" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" placeholder="voce@exemplo.com" />
              </div>
            )}
            {hasBackend && mode !== 'reset' && (
              <div>
                <label className="label" htmlFor="password">Senha</label>
                <input id="password" type="password" className="field" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} placeholder="Mínimo de 6 caracteres" />
              </div>
            )}
          </div>

          {error && <p role="alert" className="mt-4 rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
          {info && <p role="status" className="mt-4 rounded-xl border border-eco/40 bg-eco/10 px-3 py-2 text-sm text-eco">{info}</p>}

          <button type="submit" disabled={busy} className="btn btn-eco mt-6 w-full py-3">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
            {!hasBackend ? 'Entrar em modo demonstração' : mode === 'signin' ? 'Entrar' : mode === 'signup' ? 'Criar conta' : 'Enviar link'}
          </button>

          {hasBackend && (
            <div className="mt-5 flex flex-wrap items-center justify-between gap-2 text-sm">
              {mode === 'signin' ? (
                <>
                  <button type="button" className="text-cyan hover:underline" onClick={() => { setMode('signup'); setError(null); }}>Criar uma conta</button>
                  <button type="button" className="text-mist hover:text-white" onClick={() => { setMode('reset'); setError(null); }}>Esqueci a senha</button>
                </>
              ) : (
                <button type="button" className="text-cyan hover:underline" onClick={() => { setMode('signin'); setError(null); }}>Já tenho conta</button>
              )}
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
