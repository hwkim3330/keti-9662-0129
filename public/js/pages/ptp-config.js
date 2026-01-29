/**
 * Placeholder page
 */
export function render(state) {
  const name = location.hash.slice(1) || 'Unknown';
  return `
    <div class="card">
      <div class="card-header">
        <span class="card-title">${name.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}</span>
      </div>
      <p class="text-muted">This page is under construction.</p>
    </div>
  `;
}

export function init(state, deps) {}
