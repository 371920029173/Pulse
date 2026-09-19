type ToastListener = (message: string) => void;

const listeners = new Set<ToastListener>();

export function toast(message: string): void {
  for (const l of listeners) l(message);
}

export function subscribeToast(listener: ToastListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
