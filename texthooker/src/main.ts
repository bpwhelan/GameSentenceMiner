import './app.css';

import { mount } from 'svelte';
import App from './components/App.svelte';

const app = mount(App, {
	target: document.body,
});

export default app;
