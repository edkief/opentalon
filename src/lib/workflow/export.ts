import type { Workflow } from '@/lib/db/schema'

export function downloadWorkflow(wf: Pick<Workflow, 'name' | 'description' | 'definition' | 'layout'>): void {
  const payload = {
    opentalon_workflow: '1',
    exportedAt: new Date().toISOString(),
    name: wf.name,
    description: wf.description ?? '',
    definition: wf.definition,
    layout: wf.layout,
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${wf.name.toLowerCase().replace(/\s+/g, '-')}.workflow.json`
  a.click()
  URL.revokeObjectURL(url)
}
