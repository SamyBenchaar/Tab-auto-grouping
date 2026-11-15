// Human-readable summaries (French UI), shared by the service worker and the popup.

export function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count > 1 ? pluralForm : singular}`;
}

/** "2 groupes créés · 1 onglet rangé" */
export function summarizeRun(applied) {
  const created = applied.filter((item) => !item.existing).length;
  const moved = applied.filter((item) => item.existing).reduce((total, item) => total + item.count, 0);
  const parts = [];
  if (created) parts.push(`${plural(created, 'groupe')} ${created > 1 ? 'créés' : 'créé'}`);
  if (moved) parts.push(`${plural(moved, 'onglet')} ${moved > 1 ? 'rangés' : 'rangé'}`);
  return parts.join(' · ') || 'Aucun regroupement pertinent';
}

/** "<title> (4) · <title> (+1)" */
export function describeApplied(applied) {
  return applied.map((item) => `${item.title || 'Sans nom'} (${item.existing ? '+' : ''}${item.count})`).join(' · ');
}

export function sourceLabel(source, model) {
  switch (source) {
    case 'gemini':
      return model ? `Gemini (${model})` : 'Gemini';
    case 'cache':
      return 'cache local';
    case 'heuristic':
      return 'heuristique locale';
    default:
      return source ?? '';
  }
}

export function formatSeconds(ms) {
  return `${(ms / 1000).toFixed(1).replace('.', ',')} s`;
}

/** "19:00" in the user's time zone ('demain' when the date is unusable). */
export function formatTime(iso) {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return 'demain';
  return new Date(time).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

/** "12/50 aujourd'hui"; '' without a daily limit (owner token). */
export function formatQuota(quota) {
  if (!quota || !Number.isFinite(quota.used) || !Number.isFinite(quota.limit)) return '';
  return `${quota.used}/${quota.limit} aujourd'hui`;
}
