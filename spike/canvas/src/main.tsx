import { createRoot } from 'react-dom/client';
import App from './App';

performance.mark('dm:boot');
createRoot(document.getElementById('root')!).render(<App />);
