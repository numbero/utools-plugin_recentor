import {createReadStream, promises as fs} from 'fs'
import {join} from 'path'
import {createInterface} from 'readline'

interface SessionMetadata {
    customTitle: string
    aiTitle: string
    firstPrompt: string
    projectPath: string
    modified: number
    excluded: boolean
    hasConversation: boolean
}

export interface ClaudeSession {
    sessionId: string
    title: string
    projectPath: string
    modified: number
}

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : ''
const timestamp = (value: unknown): number => {
    const time = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : 0
    return Number.isFinite(time) ? time : 0
}

// Only direct transcript files are sessions; nested subagents and agent-*.jsonl are excluded.
const sessionFilename = /^([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})\.jsonl$/i

function userText(record: any): string {
    if (record.isMeta || record.isCompactSummary || record.isVisibleInTranscriptOnly) return ''
    const content = record.message?.content
    const value = typeof content === 'string' ? content : Array.isArray(content)
        ? content.filter(block => block?.type === 'text').map(block => text(block.text)).join('\n') : ''
    return value
        .replace(/<(system-reminder|ide_opened_file|ide_selection|local-command-caveat|local-command-stdout|command-name|command-message|command-args|task-notification)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
        .replace(/^\s*\[Request interrupted by user[^\]]*\]\s*$/g, '')
        .trim()
}

export class SessionReader {
    private cache = new Map<string, {signature: string, metadata: SessionMetadata}>()

    private async readTranscript(path: string, sessionId: string): Promise<SessionMetadata> {
        const metadata: SessionMetadata = {
            customTitle: '', aiTitle: '', firstPrompt: '', projectPath: '',
            modified: 0, excluded: false, hasConversation: false,
        }
        const input = createReadStream(path, {encoding: 'utf8'})
        const lines = createInterface({input, crlfDelay: Infinity})
        try {
            for await (const line of lines) {
                let record: any
                try { record = JSON.parse(line) } catch { continue }
                if (!record || typeof record !== 'object') continue
                if (record.sessionId && record.sessionId !== sessionId) continue
                if (record.isSidechain === true || ['bg', 'background', 'subagent'].includes(record.sessionKind)) {
                    metadata.excluded = true
                }
                metadata.projectPath ||= text(record.cwd)
                metadata.modified = Math.max(metadata.modified, timestamp(record.timestamp))
                if (record.type === 'custom-title') metadata.customTitle = text(record.customTitle) || metadata.customTitle
                if (record.type === 'ai-title') metadata.aiTitle = text(record.aiTitle) || metadata.aiTitle
                if (record.type === 'user' || record.type === 'assistant') metadata.hasConversation = true
                if (record.type === 'user' && !metadata.firstPrompt) metadata.firstPrompt = userText(record)
            }
        } finally {
            lines.close()
            input.destroy()
        }
        return metadata
    }

    async read(root: string): Promise<{sessions: ClaudeSession[], partial: boolean}> {
        const projects = join(root, 'projects')
        const directories = await fs.readdir(projects, {withFileTypes: true})
        const jobs: Array<{path: string, sessionId: string, entry: any, originalPath: string}> = []
        let partial = false
        for (const directory of directories) {
            if (!directory.isDirectory()) continue
            const project = join(projects, directory.name)
            try {
                const files = await fs.readdir(project, {withFileTypes: true})
                let index: any = {}
                try {
                    index = JSON.parse(await fs.readFile(join(project, 'sessions-index.json'), 'utf8')) ?? {}
                    if (!Array.isArray(index.entries)) { index = {}; partial = true }
                } catch (error: any) {
                    if (error.code !== 'ENOENT') partial = true
                }
                const entries = new Map<string, any>()
                for (const entry of index.entries ?? []) {
                    if (entry && typeof entry.sessionId === 'string') entries.set(entry.sessionId, entry)
                }
                for (const file of files) {
                    const match = file.isFile() && sessionFilename.exec(file.name)
                    if (match) jobs.push({path: join(project, file.name), sessionId: match[1],
                        entry: entries.get(match[1]) ?? {}, originalPath: text(index.originalPath)})
                }
            } catch { partial = true }
        }
        const seen = new Set(jobs.map(job => job.path))
        for (const path of this.cache.keys()) if (!seen.has(path)) this.cache.delete(path)
        const sessions = new Map<string, ClaudeSession>()
        let next = 0
        // Avoid opening all transcripts at once, and never retain message bodies in the cache.
        await Promise.all(Array.from({length: Math.min(4, jobs.length)}, async () => {
            while (next < jobs.length) {
                const job = jobs[next++]
                try {
                    const stat = await fs.stat(job.path)
                    const signature = `${stat.size}:${stat.mtimeMs}`
                    const cached = this.cache.get(job.path)
                    const metadata = cached?.signature === signature ? cached.metadata
                        : await this.readTranscript(job.path, job.sessionId)
                    this.cache.set(job.path, {signature, metadata})
                    if (metadata.excluded || job.entry.isSidechain === true ||
                        ['bg', 'background', 'subagent'].includes(job.entry.sessionKind)) continue
                    if (!metadata.hasConversation && !job.entry.sessionId) continue
                    const session: ClaudeSession = {
                        sessionId: job.sessionId,
                        title: metadata.customTitle || text(job.entry.customTitle) || metadata.aiTitle ||
                            text(job.entry.aiTitle) || text(job.entry.summary) || metadata.firstPrompt || userText({message: {content: job.entry.firstPrompt}}),
                        projectPath: metadata.projectPath || text(job.entry.projectPath) || job.originalPath,
                        modified: metadata.modified || timestamp(job.entry.modified) || stat.mtimeMs,
                    }
                    const previous = sessions.get(session.sessionId)
                    if (!previous || session.modified > previous.modified ||
                        (session.modified === previous.modified && session.projectPath < previous.projectPath)) {
                        sessions.set(session.sessionId, session)
                    }
                } catch { this.cache.delete(job.path); partial = true }
            }
        }))
        return {sessions: [...sessions.values()].sort((a, b) => b.modified - a.modified || a.sessionId.localeCompare(b.sessionId)), partial}
    }
}
