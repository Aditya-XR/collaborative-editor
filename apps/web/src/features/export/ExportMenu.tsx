import type { Editor } from '@tiptap/react'
import { useRef, useState } from 'react'
import { download, fileName } from './download'
import { toMarkdown } from './markdown'

const MENU_ITEM =
  'w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-slate-800'

/**
 * Markdown, Word and PDF, all made in the browser from the text on screen, so they work offline
 * (ADR 0020). PDF is the browser's own print-to-PDF with a print stylesheet: its text stays
 * selectable and searchable, which a picture of the page would not be.
 */
export function ExportMenu({ editor, title }: { editor: Editor | null; title: string }) {
  const menu = useRef<HTMLDetailsElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function close() {
    menu.current?.removeAttribute('open')
  }

  function markdown() {
    if (!editor) return
    close()
    const text = toMarkdown(editor.getJSON())
    download(new Blob([text], { type: 'text/markdown;charset=utf-8' }), fileName(title, 'md'))
  }

  async function word() {
    if (!editor) return
    setBusy(true)
    setError(null)
    try {
      // About 200 kB of Word-writing code, fetched only when someone asks for a .docx.
      const { toDocx } = await import('./docx')
      download(await toDocx(editor.getJSON(), title), fileName(title, 'docx'))
      close()
    } catch {
      setError('Could not make the Word file. Try again.')
    } finally {
      setBusy(false)
    }
  }

  function pdf() {
    close()
    // The browser's dialog offers "Save as PDF"; its file name comes from the page title.
    globalThis.print()
  }

  return (
    <details ref={menu} className="relative print:hidden">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800">
        Download
        <span aria-hidden="true" className="text-xs">
          ▾
        </span>
      </summary>
      <div
        role="menu"
        aria-label="Download as"
        className="absolute right-0 z-20 mt-2 flex w-52 flex-col rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg dark:border-slate-700 dark:bg-slate-900"
      >
        <button
          type="button"
          role="menuitem"
          className={MENU_ITEM}
          disabled={!editor}
          onClick={markdown}
        >
          Markdown (.md)
        </button>
        <button
          type="button"
          role="menuitem"
          className={MENU_ITEM}
          disabled={!editor || busy}
          aria-busy={busy || undefined}
          onClick={() => void word()}
        >
          {busy ? 'Making Word file…' : 'Word (.docx)'}
        </button>
        <button type="button" role="menuitem" className={MENU_ITEM} onClick={pdf}>
          PDF (print)
        </button>
        {error && <p className="px-3 py-1.5 text-xs text-rose-600 dark:text-rose-400">{error}</p>}
      </div>
    </details>
  )
}
