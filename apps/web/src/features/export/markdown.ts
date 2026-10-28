import type { JSONContent } from '@tiptap/core'

/**
 * Turns a document (the editor's JSON) into GitHub-flavoured Markdown: headings, lists and
 * checklists, quotes, code, tables, links and images. Underline has no Markdown form and becomes
 * <u>…</u>, which GitHub renders. Written out rather than taken from a library: the document has
 * a dozen node types, and each rule here is one a reader can check (ADR 0020).
 */
export function toMarkdown(doc: JSONContent): string {
  const text = blocks(doc.content ?? []).join('\n\n')
  return text ? `${text}\n` : ''
}

// ----- blocks -------------------------------------------------------------------------------------

function blocks(nodes: JSONContent[]): string[] {
  return nodes.map(block).filter((text) => text !== '')
}

function block(node: JSONContent): string {
  switch (node.type) {
    case 'paragraph':
      return escapeLineStart(inline(node.content ?? []))
    case 'heading': {
      const level = Math.min(Math.max(Number(node.attrs?.level ?? 1), 1), 6)
      const text = inline(node.content ?? [])
      return text ? `${'#'.repeat(level)} ${text}` : ''
    }
    case 'blockquote':
      return prefixLines(blocks(node.content ?? []).join('\n\n'), '> ', '> ', '>')
    case 'codeBlock':
      return codeBlock(plainText(node), String(node.attrs?.language ?? ''))
    case 'horizontalRule':
      return '---'
    case 'bulletList':
      return list(node, () => '- ')
    case 'orderedList': {
      const start = Number(node.attrs?.start ?? 1)
      return list(node, (index) => `${start + index}. `)
    }
    case 'taskList':
      return list(node, (_index, item) => (item.attrs?.checked ? '- [x] ' : '- [ ] '))
    case 'image':
      return image(node)
    case 'table':
      return table(node)
    default:
      // Unknown nodes keep their words.
      return escapeLineStart(inline(node.content ?? []))
  }
}

function list(node: JSONContent, marker: (index: number, item: JSONContent) => string): string {
  return (node.content ?? [])
    .map((item, index) => {
      const prefix = marker(index, item)
      // A paragraph followed by a nested list stays tight; anything else is its own paragraph.
      const parts = (item.content ?? []).map((child, i, all) => ({
        text: block(child),
        tight: i > 0 && isList(child) && !isList(all[i - 1]!),
      }))
      let body = ''
      for (const [i, part] of parts.entries()) {
        if (part.text === '') continue
        body += i === 0 || body === '' ? part.text : `${part.tight ? '\n' : '\n\n'}${part.text}`
      }
      return prefixLines(body, prefix, ' '.repeat(prefix.length), '')
    })
    .join('\n')
}

const isList = (node: JSONContent) =>
  node.type === 'bulletList' || node.type === 'orderedList' || node.type === 'taskList'

function codeBlock(code: string, language: string): string {
  // A fence longer than any run of backticks inside, so the code cannot close it.
  const longest = Math.max(2, ...[...code.matchAll(/`+/g)].map((match) => match[0].length))
  const fence = '`'.repeat(longest + 1)
  return `${fence}${language.replace(/[`\s]/g, '')}\n${code}\n${fence}`
}

function image(node: JSONContent): string {
  const src = String(node.attrs?.src ?? '')
  if (!src) return ''
  const alt = escapeText(String(node.attrs?.alt ?? ''))
  const title = node.attrs?.title ? ` "${String(node.attrs.title).replace(/"/g, '\\"')}"` : ''
  return `![${alt}](${destination(src)}${title})`
}

function table(node: JSONContent): string {
  const rows = (node.content ?? []).map((row) =>
    (row.content ?? []).map((cell) => {
      // A cell holds blocks; a Markdown cell holds one line.
      const text = (cell.content ?? [])
        .map((child) => (child.type === 'paragraph' ? inline(child.content ?? []) : block(child)))
        .filter(Boolean)
        .join('<br>')
      return text.replace(/\|/g, '\\|').replace(/\\?\n/g, '<br>')
    }),
  )
  if (rows.length === 0) return ''
  const width = Math.max(...rows.map((row) => row.length))
  const pad = (row: string[]) => [...row, ...Array<string>(width - row.length).fill('')]
  const line = (row: string[]) => `| ${pad(row).join(' | ')} |`
  // GitHub tables need a header row: the first row is one.
  return [
    line(rows[0]!),
    `| ${Array<string>(width).fill('---').join(' | ')} |`,
    ...rows.slice(1).map(line),
  ].join('\n')
}

/** Puts `first` before the first line, `rest` before the others, and `blank` on empty ones. */
function prefixLines(text: string, first: string, rest: string, blank: string): string {
  return text
    .split('\n')
    .map((line, index) =>
      index === 0 ? `${first}${line}` : line === '' ? blank : `${rest}${line}`,
    )
    .join('\n')
}

function plainText(node: JSONContent): string {
  if (node.type === 'text') return node.text ?? ''
  if (node.type === 'hardBreak') return '\n'
  return (node.content ?? []).map(plainText).join('')
}

// ----- inline -------------------------------------------------------------------------------------

/** Marks from outermost to innermost, so the delimiters always nest properly. */
const MARK_ORDER = ['link', 'bold', 'italic', 'strike', 'underline', 'code'] as const
type MarkName = (typeof MARK_ORDER)[number]

interface Mark {
  name: MarkName
  href?: string
}

function marksOf(node: JSONContent): Mark[] {
  const marks: Mark[] = []
  for (const mark of node.marks ?? []) {
    if (!(MARK_ORDER as readonly string[]).includes(mark.type)) continue
    marks.push({ name: mark.type as MarkName, href: mark.attrs?.href as string | undefined })
  }
  return marks.sort((a, b) => MARK_ORDER.indexOf(a.name) - MARK_ORDER.indexOf(b.name))
}

const sameMark = (a: Mark, b: Mark) => a.name === b.name && a.href === b.href

function open(mark: Mark): string {
  switch (mark.name) {
    case 'link':
      return '['
    case 'bold':
      return '**'
    case 'italic':
      return '*'
    case 'strike':
      return '~~'
    case 'underline':
      return '<u>'
    case 'code':
      return '' // written with its text, which picks the backtick count
  }
}

function close(mark: Mark): string {
  switch (mark.name) {
    case 'link':
      return `](${destination(mark.href ?? '')})`
    case 'bold':
      return '**'
    case 'italic':
      return '*'
    case 'strike':
      return '~~'
    case 'underline':
      return '</u>'
    case 'code':
      return ''
  }
}

/**
 * Inline content with its marks. Marks shared by neighbouring pieces of text stay open across
 * them (`**a *b***`, not `**a****b**`), and spaces move outside the delimiters, where Markdown
 * requires them.
 */
function inline(nodes: JSONContent[]): string {
  let out = ''
  let active: Mark[] = []
  let held = '' // trailing spaces, written after whatever closes next

  for (const node of nodes) {
    if (node.type === 'hardBreak') {
      out += closeAll(active) + held
      active = []
      held = ''
      out += '\\\n'
      continue
    }
    if (node.type === 'image') {
      out += closeAll(active) + held + image(node)
      active = []
      held = ''
      continue
    }
    const raw = node.text ?? ''
    if (raw === '') continue
    const marks = marksOf(node)
    const code = marks.some((mark) => mark.name === 'code')

    // Keep the longest run of open marks this text shares; close the rest, innermost first.
    let keep = 0
    while (keep < active.length && keep < marks.length && sameMark(active[keep]!, marks[keep]!)) {
      keep += 1
    }
    out += active.slice(keep).reverse().map(close).join('') + held
    held = ''
    active = active.slice(0, keep)

    const [, lead, body, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(raw)!
    out += lead
    if (body === '') {
      held = trail!
      continue
    }
    for (const mark of marks.slice(keep)) {
      out += open(mark)
      active.push(mark)
    }
    out += code ? codeSpan(body!) : escapeText(body!)
    held = trail!
  }
  return out + closeAll(active) + held
}

function closeAll(marks: Mark[]): string {
  return [...marks].reverse().map(close).join('')
}

function codeSpan(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length))
  const ticks = '`'.repeat(longest + 1)
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : ''
  return `${ticks}${pad}${text}${pad}${ticks}`
}

// ----- escaping -----------------------------------------------------------------------------------

/** Characters that would otherwise start emphasis, code, links or HTML. */
function escapeText(text: string): string {
  return text.replace(/[\\`*_[\]<>~]/g, '\\$&')
}

/** Words at the start of a paragraph that Markdown would read as a heading, list or quote. */
function escapeLineStart(text: string): string {
  return text.replace(/^(#{1,6}\s|[-+=]\s)/, '\\$1').replace(/^(\d+)([.)]\s)/, '$1\\$2')
}

/** A link or image address; angle brackets keep spaces and parentheses inside it. */
function destination(url: string): string {
  return /[\s()<>]/.test(url) ? `<${url.replace(/[<>]/g, encodeURIComponent)}>` : url
}
