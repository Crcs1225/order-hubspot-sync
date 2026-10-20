const rows = document.querySelector('#attempts');
const message = document.querySelector('#message');
const refresh = document.querySelector('#refresh');
let loading = false;

async function load() {
  if (loading) return;
  loading = true;
  refresh.disabled = true;
  try {
    const response = await fetch('/api/sync-attempts');
    if (!response.ok) throw new Error('Could not load sync attempts.');
    const attempts = await response.json();
    rows.replaceChildren();
    for (const attempt of attempts) {
      const row = document.createElement('tr');
      const values = [attempt.order_id, attempt.status, attempt.contact_id ?? '—', attempt.deal_id ?? '—', new Date(attempt.timestamp).toLocaleString(), attempt.error ?? '—'];
      values.forEach((value, index) => {
        const cell = document.createElement('td');
        if (index === 1) {
          const badge = document.createElement('span');
          badge.className = `status ${attempt.status}`;
          badge.textContent = value;
          cell.append(badge);
        } else cell.textContent = value;
        row.append(cell);
      });
      const action = document.createElement('td');
      if (attempt.status === 'failed') {
        const button = document.createElement('button');
        button.textContent = 'Retry';
        button.setAttribute('aria-label', `Retry ${attempt.order_id}, attempt ${attempt.id}`);
        button.addEventListener('click', async () => {
          button.disabled = true;
          button.textContent = 'Retrying…';
          try {
            const result = await fetch(`/api/sync-attempts/${attempt.id}/retry`, { method: 'POST' });
            const data = await result.json();
            await load();
            message.textContent = result.ok ? `Order ${attempt.order_id}: ${data.status}.` : (data.error || 'Retry failed. Check the latest attempt below.');
          } catch { message.textContent = 'Could not reach the server. Try again.'; }
          finally { button.disabled = false; button.textContent = 'Retry'; }
        });
        action.append(button);
      }
      row.append(action); rows.append(row);
    }
    message.textContent = attempts.length ? `${attempts.length} recent attempts · Updated ${new Date().toLocaleTimeString()}` : 'No syncs yet. Send a sample order to get started.';
  } catch (error) { message.textContent = error.message; }
  finally { loading = false; refresh.disabled = false; }
}
refresh.addEventListener('click', load);
load();
setInterval(load, 10000);
