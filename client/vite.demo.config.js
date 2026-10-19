// Layout harness config: swaps the socket + WebRTC mesh for fakes so the
// call screen can be opened with ?n=<peers>&video=1&cam=1 and no server.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const src = (f) => path.resolve(__dirname, 'src', f);
export default defineConfig({
  plugins: [react()],
  root: path.resolve(__dirname, 'dev'),
  publicDir: false,
  server: { port: 5174, host: true },
  resolve: {
    alias: [
      { find: /^\.\/lib$/, replacement: path.resolve(__dirname, 'dev/lib.mock.js') },
      { find: /^\.\/useMesh$/, replacement: path.resolve(__dirname, 'dev/useMesh.mock.js') },
      { find: '../src/lib.real', replacement: src('lib.js') }
    ]
  }
});
