import { useEffect, useRef, useState } from 'react';

/**
 * Live captions for the Language room.
 *
 * Each phone transcribes ITS OWN speaker with the browser's speech
 * recognition (on-device dictation on iOS and Android) and sends the text —
 * never audio — over the socket. Captions from everyone are shown in a lane
 * under the stage. Translation, when the host turns it on, sends caption
 * text to the Worker; audio still never leaves the phone.
 */
export const LANGS = [
  ['en-US', 'English'], ['es-ES', 'Español'], ['es-MX', 'Español (México)'], ['pt-BR', 'Português'],
  ['fr-FR', 'Français'], ['de-DE', 'Deutsch'], ['it-IT', 'Italiano'], ['ja-JP', '日本語'],
  ['ko-KR', '한국어'], ['zh-CN', '中文'], ['ar-SA', 'العربية'], ['he-IL', 'עברית'], ['hi-IN', 'हिन्दी'], ['ru-RU', 'Русский']
];

export const speechSupported = () =>
  typeof window !== 'undefined' && !!(window.SpeechRecognition || window.webkitSpeechRecognition);

export default function useCaptions({ enabled, lang, micOn, onFinal, onInterim }) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState('');
  const recRef = useRef(null);
  const wantRef = useRef(false);
  const cbRef = useRef({ onFinal, onInterim });
  cbRef.current = { onFinal, onInterim };

  useEffect(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    wantRef.current = enabled && micOn && !!SR;
    if (!wantRef.current) { recRef.current?.stop?.(); recRef.current = null; setListening(false); return; }

    let rec = new SR();
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    let lastInterim = '';
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const t = r[0].transcript.trim();
        if (!t) continue;
        if (r.isFinal) cbRef.current.onFinal?.(t);
        else interim += (interim ? ' ' : '') + t;
      }
      if (interim !== lastInterim) { lastInterim = interim; cbRef.current.onInterim?.(interim); }
    };
    rec.onerror = (e) => {
      // 'no-speech' and 'aborted' are routine; anything else is worth showing once
      if (e.error && !['no-speech', 'aborted'].includes(e.error)) setError(e.error === 'not-allowed' ? 'Microphone access is needed for captions.' : `Captions paused (${e.error}).`);
    };
    rec.onstart = () => { setListening(true); setError(''); };
    // Browsers stop continuous recognition after a while (iOS ~1 min); restart while wanted.
    rec.onend = () => { setListening(false); if (wantRef.current && recRef.current === rec) { try { rec.start(); } catch { /* restarts too fast; the next effect run will retry */ } } };
    recRef.current = rec;
    try { rec.start(); } catch (err) { setError('Captions could not start.'); }
    return () => { wantRef.current = false; try { rec.onend = null; rec.stop(); } catch { /* fine */ } if (recRef.current === rec) recRef.current = null; setListening(false); };
  }, [enabled, lang, micOn]);

  return { listening, error, supported: speechSupported() };
}
