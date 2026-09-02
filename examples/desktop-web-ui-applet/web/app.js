const status = document.querySelector('#runtime-status');

if (status instanceof HTMLElement) {
  status.textContent =
    window.location.protocol === 'file:' ? 'Static file preview' : 'Isolated origin preview';
}
