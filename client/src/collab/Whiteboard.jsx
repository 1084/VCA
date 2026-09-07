import { useEffect, useRef, useState } from 'react';

const PENS = ['#E8EFF0', '#FFB454', '#7CCFDE', '#8FE3B0', '#F5A0C0'];

/**
 * Shared whiteboard. Strokes live in a Y.Array on the room doc:
 * { color, size, points: [[x,y], ...] } with points normalized to 0..1
 * so every screen size renders the same drawing. A stroke is pushed on
 * pointer-up; in-progress strokes render locally for zero-lag feel.
 */
export default function Whiteboard({ ydoc }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const drawing = useRef(null);
  const [color, setColor] = useState(PENS[1]);
  const [size, setSize] = useState(3);

  useEffect(() => {
    const strokes = ydoc.getArray('whiteboard');
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');

    const paintStroke = (s, w, h) => {
      if (!s?.points?.length) return;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.size;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      s.points.forEach(([x, y], i) =>
        i === 0 ? ctx.moveTo(x * w, y * h) : ctx.lineTo(x * w, y * h)
      );
      ctx.stroke();
    };
    const repaint = () => {
      const { width: w, height: h } = canvas;
      ctx.clearRect(0, 0, w, h);
      strokes.toArray().forEach((s) => paintStroke(s, w, h));
      if (drawing.current) paintStroke(drawing.current, w, h);
    };

    const resize = () => {
      const rect = wrapRef.current.getBoundingClientRect();
      canvas.width = Math.max(1, rect.width);
      canvas.height = Math.max(1, rect.height);
      repaint();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(wrapRef.current);
    resize();

    strokes.observe(repaint);
    canvas.__repaint = repaint;
    return () => {
      strokes.unobserve(repaint);
      ro.disconnect();
    };
  }, [ydoc]);

  const norm = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    return [
      Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height))
    ];
  };
  const down = (e) => {
    e.preventDefault();
    canvasRef.current.setPointerCapture(e.pointerId);
    drawing.current = { color, size, points: [norm(e)] };
  };
  const move = (e) => {
    if (!drawing.current) return;
    drawing.current.points.push(norm(e));
    canvasRef.current.__repaint?.();
  };
  const up = () => {
    if (!drawing.current) return;
    if (drawing.current.points.length > 1) {
      ydoc.getArray('whiteboard').push([drawing.current]);
    }
    drawing.current = null;
    canvasRef.current.__repaint?.();
  };
  const clearBoard = () => {
    if (!window.confirm('Clear the whiteboard for everyone?')) return;
    const strokes = ydoc.getArray('whiteboard');
    strokes.delete(0, strokes.length);
  };

  return (
    <>
      <div className="wb-tools">
        {PENS.map((c) => (
          <button key={c} className={`swatch ${color === c ? 'on' : ''}`}
            style={{ background: c }} aria-label={`Pen color ${c}`}
            onClick={() => setColor(c)} />
        ))}
        <button className={`wb-btn ${size === 3 ? 'on' : ''}`} onClick={() => setSize(3)}>Thin</button>
        <button className={`wb-btn ${size === 7 ? 'on' : ''}`} onClick={() => setSize(7)}>Thick</button>
        <button className="wb-btn wb-clear" onClick={clearBoard}>Clear</button>
      </div>
      <div className="wb-stage" ref={wrapRef}>
        <canvas ref={canvasRef}
          onPointerDown={down} onPointerMove={move}
          onPointerUp={up} onPointerLeave={up} />
      </div>
    </>
  );
}
