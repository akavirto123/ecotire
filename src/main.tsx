import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { AuthProvider } from './hooks/useAuth.tsx';
import '@fontsource-variable/archivo/wdth.css';
import './index.css';
import './lib/theme.ts';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </StrictMode>,
);
