import { useEffect, useState } from 'react';

// "Phone" = narrow OR short viewport. A phone held sideways is ~850px wide
// but only ~390px tall, which the desktop layout can't fit either. Keep this
// query in sync with the media query in index.css.
export const PHONE_QUERY = '(max-width:760px),(max-height:500px)';

export default function usePhone() {
  const get = () => typeof window !== 'undefined' && window.matchMedia(PHONE_QUERY).matches;
  const [phone, setPhone] = useState(get);
  useEffect(() => {
    const mq = window.matchMedia(PHONE_QUERY);
    const on = () => setPhone(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return phone;
}

// Height of the on-screen keyboard, from the visual viewport. iOS Safari
// does not resize the layout viewport for the keyboard, so fixed-bottom UI
// would otherwise hide behind it. Exposed as --kb on the call screen.
export function useKeyboardInset() {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const on = () => {
      const h = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      setInset(h < 80 ? 0 : Math.round(h)); // ignore URL-bar jitter
    };
    vv.addEventListener('resize', on);
    vv.addEventListener('scroll', on);
    on();
    return () => { vv.removeEventListener('resize', on); vv.removeEventListener('scroll', on); };
  }, []);
  return inset;
}
