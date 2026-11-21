import { createRoot } from 'react-dom/client';
import { App } from './App';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
// Stand-ins for the macOS typefaces on the gear's printing (Futura, Snell Roundhand, Didot...), used where those aren't installed.
import '@fontsource-variable/jost';
import '@fontsource-variable/playfair-display';
import '@fontsource-variable/libre-baskerville';
import '@fontsource/pinyon-script';
import '@fontsource/courier-prime';
import '@fontsource/barlow-condensed/600.css';
import './app.css';

createRoot(document.getElementById('root')!).render(<App />);
