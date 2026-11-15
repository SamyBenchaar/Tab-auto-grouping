// Session state in chrome.storage.session: survives service-worker restarts (MV3 workers are
// stopped when idle) and is cleared when the browser closes (tab ids are not stable across sessions).
const STATE_KEYS = ['seen', 'lastRunAt', 'history'];
export const HISTORY_LIMIT = 10;

let queue = Promise.resolve();

function withDefaults(stored) {
  return {
    seen: stored.seen ?? {}, // tabId -> { u: analysed URL, s: 'analyzed' | 'grouped' | 'rejected' }
    lastRunAt: stored.lastRunAt ?? {}, // windowId -> timestamp of the last grouping
    history: stored.history ?? [], // last runs, for "Annuler"
  };
}

export async function readState() {
  return withDefaults(await chrome.storage.session.get(STATE_KEYS));
}

/**
 * Serialised read-modify-write of the session state (event handlers run concurrently).
 * The mutator receives a draft it may modify in place; do not call withState from inside it.
 */
export function withState(mutator) {
  const task = queue.then(async () => {
    const draft = await readState();
    const result = await mutator(draft);
    draft.history = draft.history.slice(-HISTORY_LIMIT);
    await chrome.storage.session.set(draft);
    return result;
  });
  queue = task.catch(() => undefined);
  return task;
}

export async function setStatus(status) {
  await chrome.storage.session.set({ status: { state: 'idle', message: '', ...status, at: Date.now() } });
}

export async function getStatus() {
  const { status } = await chrome.storage.session.get('status');
  return status ?? { state: 'idle', message: '', at: 0 };
}
