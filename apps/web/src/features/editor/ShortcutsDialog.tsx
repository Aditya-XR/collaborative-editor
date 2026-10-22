import { useEffect, useId, useRef } from 'react'
import { Button } from '../../components/ui/Button'
import { MOD } from './keys'

const SHORTCUTS: [string, string][] = [
  ['Bold, italic, underline', `${MOD}+B, ${MOD}+I, ${MOD}+U`],
  ['Strikethrough', `${MOD}+Shift+S`],
  ['Inline code', `${MOD}+E`],
  ['Link', `${MOD}+K`],
  ['Heading 1, 2, 3', `${MOD}+Alt+1, 2, 3`],
  ['Numbered, bullet, checklist', `${MOD}+Shift+7, 8, 9`],
  ['Quote', `${MOD}+Shift+B`],
  ['Code block', `${MOD}+Alt+C`],
  ['Indent or outdent a list item', 'Tab, Shift+Tab'],
  ['Next table cell', 'Tab'],
  ['Undo your own changes, redo', `${MOD}+Z, ${MOD}+Shift+Z`],
  ['Comment on the selection', `${MOD}+Alt+M`],
]

const MARKDOWN: [string, string][] = [
  ['# , ## , ###', 'Heading'],
  ['- or *', 'Bullet list'],
  ['1.', 'Numbered list'],
  ['[ ] or [x]', 'Checklist'],
  ['>', 'Quote'],
  ['```', 'Code block'],
  ['---', 'Divider'],
]

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const titleId = useId()
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    globalThis.addEventListener('keydown', onKey)
    panel.current?.querySelector<HTMLElement>('button')?.focus()
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-30 flex items-start justify-center overflow-y-auto bg-slate-950/40 p-4 pt-[8vh]"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 shadow-xl dark:border-slate-800 dark:bg-slate-900"
      >
        <div className="flex items-start justify-between gap-4">
          <h2 id={titleId} className="text-lg font-semibold">
            Keyboard shortcuts
          </h2>
          <Button variant="ghost" onClick={onClose} aria-label="Close keyboard shortcuts">
            ✕
          </Button>
        </div>
        <ShortcutTable rows={SHORTCUTS} caption="Shortcuts" />
        <p className="mt-5 text-sm text-slate-600 dark:text-slate-300">
          Or type these at the start of a line, then a space:
        </p>
        <ShortcutTable rows={MARKDOWN.map(([keys, what]) => [what, keys])} caption="Typing" />
      </div>
    </div>
  )
}

function ShortcutTable({ rows, caption }: { rows: [string, string][]; caption: string }) {
  return (
    <table className="mt-3 w-full text-sm">
      <caption className="sr-only">{caption}</caption>
      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
        {rows.map(([what, keys]) => (
          <tr key={what}>
            <td className="py-1.5 pr-4 text-slate-700 dark:text-slate-200">{what}</td>
            <td className="py-1.5 text-right font-mono text-xs text-slate-500 dark:text-slate-400">
              {keys}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
