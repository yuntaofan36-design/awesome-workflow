import { createStandaloneHost } from './standaloneHost';
import { mount } from './remote';

const container = document.querySelector<HTMLElement>('#root');
if (!container) throw new Error('Control plane root is missing');

void mount(container, createStandaloneHost());
