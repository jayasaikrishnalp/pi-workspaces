import { useEffect, useState } from 'react'

export interface Toast { id: string; title: string; message?: string; kind?: 'info' | 'success' | 'error' }

interface Props { toasts: Toast[]; dismiss: (id: string) => void }

export function ToastStack({ toasts, dismiss }: Props): JSX.Element {
  return (
    <div className="toast-stack" data-testid="toast-stack">
      {toasts.map((t) => <ToastItem key={t.id} toast={t} dismiss={dismiss} />)}
    </div>
  )
}

function ToastItem({ toast, dismiss }: { toast: Toast; dismiss: (id: string) => void }): JSX.Element {
  const [visible, setVisible] = useState(true)
  useEffect(() => {
    const t = setTimeout(() => setVisible(false), 4000)
    const r = setTimeout(() => dismiss(toast.id), 4500)
    return () => { clearTimeout(t); clearTimeout(r) }
  }, [toast.id, dismiss])
  return (
    <div className={`toast toast-${toast.kind ?? 'info'} ${visible ? '' : 'gone'}`} data-testid={`toast-${toast.id}`}>
      <div className="toast-title">{toast.title}</div>
      {toast.message ? <div className="toast-msg">{toast.message}</div> : null}
    </div>
  )
}
