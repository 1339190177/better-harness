/** Fixture UI entry: the host only needs it to exist and export a mount. */
export default function mount(container) {
  container.textContent = 'echo'
  return () => container.replaceChildren()
}
