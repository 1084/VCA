import { useState } from 'react';
import axios from 'axios';
import { BACKEND_URL } from './lib';

export default function AuthScreen({ onAuthed }) {
  const [signup, setSignup] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!email.trim() || !password) return setErr('Email and password are both needed.');
    if (signup && password.length < 8) return setErr('Password must be at least 8 characters.');
    setErr('');
    setBusy(true);
    try {
      const path = signup ? 'signup' : 'login';
      const res = await axios.post(`${BACKEND_URL}/api/${path}`, {
        email: email.trim(),
        password
      });
      onAuthed({ token: res.data.token, email: email.trim() });
    } catch (ex) {
      setErr(ex.response?.data?.error || 'Could not reach the server — is it running?');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="screen">
      <div className="auth-left">
        <div className="mark"><span className="dot" />Cove</div>
        <h1>Meetings that feel like you&rsquo;re <em>on air</em>, not on hold.</h1>
        <p className="sub">
          Secure video rooms for small teams — join with a code, share your screen,
          and work together in a shared workspace. No downloads, no plugins.
        </p>
        <div className="tally-strip">
          <span className="lamp" /> ROOM-SCOPED SIGNALING · WEBRTC · SHARED WORKSPACES
        </div>
      </div>
      <div className="auth-right">
        <form className="card" onSubmit={submit}>
          <h2>{signup ? 'Create your account' : 'Welcome back'}</h2>
          <p className="hint">
            {signup ? 'One account for every room you join.' : 'Sign in to join or start a room.'}
          </p>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" type="email" autoComplete="email" placeholder="you@company.com"
              value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="pw">Password{signup ? ' (at least 8 characters)' : ''}</label>
            <input id="pw" type="password" placeholder="••••••••"
              autoComplete={signup ? 'new-password' : 'current-password'}
              value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <p className="form-err">{err}</p>
          <button className="btn btn-primary" disabled={busy} type="submit">
            {busy ? 'One sec…' : signup ? 'Create account' : 'Sign in'}
          </button>
          <p className="switch-auth">
            {signup ? 'Already have an account? ' : 'New to Cove? '}
            <button type="button" onClick={() => { setSignup(!signup); setErr(''); }}>
              {signup ? 'Sign in' : 'Create an account'}
            </button>
          </p>
        </form>
      </div>
    </section>
  );
}
