import type { JSONContent } from '@tiptap/core'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { toDocx, type FetchImage } from './docx'
import { fileName } from './download'

const p = (...content: JSONContent[]): JSONContent => ({ type: 'paragraph', content })
const text = (value: string, ...marks: string[]): JSONContent => ({
  type: 'text',
  text: value,
  ...(marks.length > 0 ? { marks: marks.map((type) => ({ type })) } : {}),
})

const noImages: FetchImage = async () => null

/** The parts of the .docx (a zip of XML files) a test looks at. */
async function unpack(blob: Blob) {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer())
  const read = (path: string) => zip.file(path)?.async('string') ?? Promise.resolve('')
  return {
    document: await read('word/document.xml'),
    numbering: await read('word/numbering.xml'),
    core: await read('docProps/core.xml'),
    relationships: await read('word/_rels/document.xml.rels'),
  }
}

describe('toDocx', () => {
  it('writes a Word file with the text, its formatting and the title', async () => {
    const blob = await toDocx(
      {
        type: 'doc',
        content: [
          { type: 'heading', attrs: { level: 1 }, content: [text('Launch plan')] },
          p(text('Ship it '), text('soon', 'bold'), text(' and '), text('well', 'italic')),
        ],
      },
      'Q4 launch',
      noImages,
    )
    const { document, core } = await unpack(blob)

    expect(document).toContain('Heading1')
    expect(document).toContain('Launch plan')
    expect(document).toMatch(/<w:b\/>.*?soon/s)
    expect(document).toMatch(/<w:i\/>.*?well/s)
    expect(core).toContain('Q4 launch')
  })

  it('makes real Word lists: bullets, and numbering that starts where the list did', async () => {
    const item = (value: string): JSONContent => ({ type: 'listItem', content: [p(text(value))] })
    const { document, numbering } = await unpack(
      await toDocx(
        {
          type: 'doc',
          content: [
            { type: 'bulletList', content: [item('apples')] },
            { type: 'orderedList', attrs: { start: 4 }, content: [item('four'), item('five')] },
            {
              type: 'taskList',
              content: [{ type: 'taskItem', attrs: { checked: true }, content: [p(text('done'))] }],
            },
          ],
        },
        'Lists',
        noImages,
      ),
    )

    expect(document.match(/<w:numPr>/g)).toHaveLength(3) // apples, four, five
    expect(numbering).toContain('<w:start w:val="4"/>')
    expect(document).toContain('☒ ')
  })

  it('writes tables, with the header row marked as one', async () => {
    const cell = (type: string, value: string): JSONContent => ({ type, content: [p(text(value))] })
    const { document } = await unpack(
      await toDocx(
        {
          type: 'doc',
          content: [
            {
              type: 'table',
              content: [
                {
                  type: 'tableRow',
                  content: [cell('tableHeader', 'Name'), cell('tableHeader', 'Cost')],
                },
                { type: 'tableRow', content: [cell('tableCell', 'Ink'), cell('tableCell', '10')] },
              ],
            },
          ],
        },
        'Table',
        noImages,
      ),
    )

    expect(document.match(/<w:tr>|<w:tr /g)).toHaveLength(2)
    expect(document).toContain('<w:tblHeader/>')
    expect(document).toContain('Ink')
  })

  it('embeds images it can fetch, and links the ones it cannot', async () => {
    // A 1×1 PNG.
    const png = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      ),
      (c) => c.charCodeAt(0),
    )
    const fetchImage: FetchImage = async (src) =>
      src.endsWith('ok.png') ? { data: png.buffer, type: 'png', width: 1200, height: 600 } : null
    const blob = await toDocx(
      {
        type: 'doc',
        content: [
          { type: 'image', attrs: { src: 'https://example.com/ok.png', alt: 'Chart' } },
          { type: 'image', attrs: { src: 'https://example.com/blocked.png', alt: 'Logo' } },
        ],
      },
      'Images',
      fetchImage,
    )
    const zip = await JSZip.loadAsync(await blob.arrayBuffer())
    const { document, relationships } = await unpack(blob)

    expect(Object.keys(zip.files).some((path) => path.startsWith('word/media/'))).toBe(true)
    // Scaled to fit the page: 1200×600 px becomes 600×300 px (9525 EMU per pixel).
    expect(document).toContain(`cx="${600 * 9525}" cy="${300 * 9525}"`)
    expect(document).toContain('[Image: Logo] https://example.com/blocked.png')
    expect(relationships).toContain('https://example.com/blocked.png')
  })
})

describe('fileName', () => {
  it('names the file after the title, minus what file systems refuse', () => {
    expect(fileName('Q4: plan / draft?', 'docx')).toBe('Q4 plan draft.docx')
    expect(fileName('  ...  ', 'md')).toBe('Untitled document.md')
    expect(fileName('a\u0007b', 'md')).toBe('ab.md')
    expect(fileName('x'.repeat(300), 'md')).toHaveLength(120 + '.md'.length)
  })
})
