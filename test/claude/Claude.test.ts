import {appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync} from 'fs'
import {tmpdir} from 'os'
import {dirname, join} from 'path'
import {Context} from '../../src/Context'
import {i18n, sentenceKey} from '../../src/i18n'
import {ClaudeApplication, CopySessionIdExecutor} from '../../src/parser/claude/Claude'
import {ClaudeArgs} from '../../src/parser/claude/ClaudeArgs'
import {SessionReader} from '../../src/parser/claude/SessionReader'
import {ProjectItemImpl} from '../../src/Types'

let root: string
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const user = (extra = {}) => ({type: 'user', cwd: '/projects/my-project', message: {content: '登录问题'}, ...extra})
const action = {code: 'claude-sessions', type: 'text', payload: ''}
function transcript(n: number, records: any[], project = 'encoded-project'): string {
    const path = join(root, 'projects', project, `${id(n)}.jsonl`)
    mkdirSync(dirname(path), {recursive: true})
    writeFileSync(path, records.map(record => JSON.stringify(record)).join('\n') + '\n')
    return path
}
function index(entries: any[], project = 'encoded-project', originalPath = '/index/original'): void {
    const path = join(root, 'projects', project, 'sessions-index.json')
    mkdirSync(dirname(path), {recursive: true})
    writeFileSync(path, JSON.stringify({version: 1, entries, originalPath}))
}
function configuredApp(): ClaudeApplication {
    const app = new ClaudeApplication()
    utools.dbStorage.setItem(app.enabledId(utools.getNativeId()), true)
    utools.dbStorage.setItem(app.configId(utools.getNativeId()), root)
    app.update(utools.getNativeId())
    return app
}
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'claude-session-test-'))
    jest.clearAllMocks()
    i18n.locale('zh-CN')
})
afterEach(() => {
    jest.restoreAllMocks()
    rmSync(root, {recursive: true, force: true})
    const app = new ClaudeApplication()
    utools.dbStorage.removeItem(app.configId(utools.getNativeId()))
    utools.dbStorage.removeItem(app.enabledId(utools.getNativeId()))
})

test('uses latest manual title, initial cwd, live transcripts and deterministic recency order', async () => {
    transcript(1, [user({timestamp: '2026-01-01'}), {type: 'custom-title', customTitle: 'Old'},
        {type: 'ai-title', aiTitle: 'Automatic'}, {type: 'custom-title', customTitle: 'Manual\nLatest'},
        user({cwd: '/later/cwd'})])
    transcript(2, [user({timestamp: '2026-02-01'}), {type: 'ai-title', aiTitle: 'Old automatic'},
        {type: 'ai-title', aiTitle: 'New automatic'}])
    index([{sessionId: id(1), summary: 'Old summary'}, {sessionId: id(99), summary: 'Deleted file'}])
    const {sessions, partial} = await new SessionReader().read(root)
    expect(partial).toBe(false)
    expect(sessions.map(s => s.sessionId)).toEqual([id(2), id(1)])
    expect(sessions[0].title).toBe('New automatic')
    expect(sessions[1]).toMatchObject({title: 'Manual\nLatest', projectPath: '/projects/my-project'})
})

test('falls back through legacy summary, real user text, unnamed title and original project path', async () => {
    transcript(1, [user({cwd: undefined})])
    transcript(2, [user({cwd: undefined, isMeta: true, message: {content: 'Injected'}}),
        user({cwd: undefined, message: {content: [{type: 'tool_result', content: 'Secret'},
            {type: 'text', text: '<ide_opened_file>Injected</ide_opened_file>\nReal prompt'}]}})])
    transcript(3, [user({cwd: undefined, message: {content: [{type: 'tool_result', content: 'Not a title'}]}})], 'no-index')
    index([{sessionId: id(1), summary: 'Legacy summary', projectPath: 'C:\\Projects\\Legacy'}, {sessionId: id(2)}])
    const items = await configuredApp().generateProjectItems(Context.get())
    expect(items.find(s => s.id === id(1))).toMatchObject({title: 'Legacy summary', description: 'C:\\Projects\\Legacy'})
    expect(items.find(s => s.id === id(2))).toMatchObject({title: 'Real prompt', description: '/index/original'})
    expect(items.find(s => s.id === id(3))).toMatchObject({title: '未命名会话', description: '项目路径未知'})
})

test('excludes background, sidechain, subagents and metadata-only transcripts; deduplicates IDs', async () => {
    transcript(1, [user({sessionKind: 'bg'})])
    transcript(2, [user({isSidechain: true})])
    transcript(3, [user({sessionKind: 'subagent'})])
    transcript(4, [user()]); index([{sessionId: id(4), isSidechain: true}])
    transcript(5, [user({timestamp: '2026-01-01'})])
    transcript(5, [user({cwd: '/newer', timestamp: '2026-02-01'})], 'duplicate')
    transcript(6, [{type: 'ai-title', aiTitle: 'No conversation'}])
    transcript(7, [user()], 'encoded-project/subagents')
    writeFileSync(join(root, 'projects/encoded-project/agent-abc.jsonl'), JSON.stringify(user()))
    const result = await new SessionReader().read(root)
    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]).toMatchObject({sessionId: id(5), projectPath: '/newer'})
})

test('tolerates corrupt lines and unfinished writes, refreshes cached metadata and removes deleted files', async () => {
    const reader = new SessionReader()
    const path = transcript(1, [user(), {type: 'ai-title', aiTitle: 'First'}])
    appendFileSync(path, 'not json\nnull\n{"type":')
    expect((await reader.read(root)).sessions[0].title).toBe('First')
    const spy = jest.spyOn(reader as any, 'readTranscript')
    await reader.read(root)
    expect(spy).not.toHaveBeenCalled()
    appendFileSync(path, '\n' + JSON.stringify({type: 'custom-title', customTitle: 'Updated'}) + '\n')
    expect((await reader.read(root)).sessions[0].title).toBe('Updated')
    expect(spy).toHaveBeenCalledTimes(1)
    unlinkSync(path)
    expect((await reader.read(root)).sessions).toEqual([])
})

test('reloads index metadata even with unchanged transcript and reports a corrupt index', async () => {
    transcript(1, [user({cwd: undefined})])
    index([{sessionId: id(1), summary: 'Before'}])
    const reader = new SessionReader()
    expect((await reader.read(root)).sessions[0].title).toBe('Before')
    index([{sessionId: id(1), summary: 'After'}])
    expect((await reader.read(root)).sessions[0].title).toBe('After')
    writeFileSync(join(root, 'projects/encoded-project/sessions-index.json'), '{')
    const result = await reader.read(root)
    expect(result.partial).toBe(true)
    expect(result.sessions).toHaveLength(1)
})

test('isolates one unreadable transcript while retaining readable sessions', async () => {
    transcript(1, [user()]); transcript(2, [user()])
    const reader = new SessionReader()
    const read = (reader as any).readTranscript.bind(reader)
    jest.spyOn(reader as any, 'readTranscript').mockImplementation((path, sessionId) =>
        sessionId === id(1) ? Promise.reject(new Error('EACCES')) : read(path, sessionId))
    const result = await reader.read(root)
    expect(result.partial).toBe(true)
    expect(result.sessions.map(s => s.sessionId)).toEqual([id(2)])
})

test('empty directory succeeds and missing directory gives an actionable error', async () => {
    const app = configuredApp()
    await expect(app.generateProjectItems(Context.get())).rejects.toThrow(i18n.t(sentenceKey.claudeDirectoryError))
    mkdirSync(join(root, 'projects'))
    await expect(app.generateProjectItems(Context.get())).resolves.toEqual([])
})

test('defaults disabled and resolves user configuration before environment before home', () => {
    const previous = process.env.CLAUDE_CONFIG_DIR
    try {
        delete process.env.CLAUDE_CONFIG_DIR
        jest.spyOn(utools, 'getPath').mockReturnValue(root)
        const app = new ClaudeApplication()
        app.update(utools.getNativeId())
        expect(app.enabled).toBe(false)
        expect((app as any).config).toBe(join(root, '.claude'))
        process.env.CLAUDE_CONFIG_DIR = '/environment/claude'
        app.update(utools.getNativeId())
        expect((app as any).config).toBe('/environment/claude')
        utools.dbStorage.setItem(app.configId(utools.getNativeId()), '/custom/claude')
        app.update(utools.getNativeId())
        expect((app as any).config).toBe('/custom/claude')
        expect(app.configSettingItemProperties()).toMatchObject({openDirectory: true, openFile: false})
    } finally {
        if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
        else process.env.CLAUDE_CONFIG_DIR = previous
    }
})

test('searches all terms across full path and full title, keeping date order', async () => {
    transcript(1, [user(), {type: 'custom-title', customTitle: '登录\nFix'}])
    const items = await configuredApp().generateProjectItems(Context.get())
    expect(items[0].title).toBe('登录 Fix')
    const args = new ClaudeArgs()
    Object.assign(args, {projectItemCache: items})
    const callback = jest.fn()
    args.search(action, '  MY-PROJECT   登录 fix ', callback)
    expect(callback).toHaveBeenLastCalledWith(items)
    args.search(action, 'my-project absent', callback)
    expect(callback.mock.calls.at(-1)[0][0].id).toBe('claude-status')
    args.search(action, '  \t ', callback)
    expect(callback).toHaveBeenLastCalledWith(items)
    args.search(action, id(1), callback)
    expect(callback.mock.calls.at(-1)[0][0].id).toBe('claude-status')
})

test.each([true, false])('copies only the session ID and follows exit setting %s', exit => {
    const context = Object.assign(Context.get(), {enableOutPluginImmediately: exit})
    new CopySessionIdExecutor(id(1)).execute(context)
    expect(utools.copyText).toHaveBeenCalledWith(id(1))
    expect(utools.showNotification).toHaveBeenCalledWith(i18n.t(sentenceKey.claudeCopied))
    expect(utools.hideMainWindow).toHaveBeenCalledTimes(exit ? 1 : 0)
    expect(utools.outPlugin).toHaveBeenCalledTimes(exit ? 1 : 0)
})

test.each(['false', 'throw'])('copy failure (%s) preserves the window and never reports success', failure => {
    jest.spyOn(console, 'error').mockImplementation(() => {})
    const copy = utools.copyText as jest.Mock
    if (failure === 'false') copy.mockReturnValueOnce(false)
    else copy.mockImplementationOnce(() => { throw new Error('Clipboard unavailable') })
    new CopySessionIdExecutor(id(1)).execute(Context.get())
    expect(utools.hideMainWindow).not.toHaveBeenCalled()
    expect(utools.outPlugin).not.toHaveBeenCalled()
    expect(utools.showNotification).not.toHaveBeenCalledWith(i18n.t(sentenceKey.claudeCopied))
    expect(utools.showNotification).toHaveBeenCalledWith(expect.stringContaining(i18n.t(sentenceKey.claudeCopyFailed)))
})

test('select executes copy without opening a project or emitting an opening notification', () => {
    const args = new ClaudeArgs()
    const item = {id: id(1), command: new CopySessionIdExecutor(id(1))} as ProjectItemImpl
    args.select(action, item, jest.fn())
    expect(utools.copyText).toHaveBeenCalledWith(id(1))
    expect(utools.showNotification).toHaveBeenCalledTimes(1)
})

test('registers exactly the claude command', () => {
    const manifest = JSON.parse(readFileSync(join(__dirname, '../../public/plugin.json'), 'utf8'))
    expect(manifest.features.filter(feature => feature.code === 'claude-sessions')).toEqual([
        expect.objectContaining({cmds: ['claude']}),
    ])
})


test('entry keeps the latest query while loading and ignores an older request completing late', async () => {
    const app = configuredApp()
    const args = new ClaudeArgs(app)
    let resolveOld: (items: any[]) => void = () => {}
    let resolveNew: (items: any[]) => void = () => {}
    jest.spyOn(app, 'generateProjectItems')
        .mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
        .mockImplementationOnce(() => new Promise(resolve => { resolveNew = resolve }))
    const callback = jest.fn()
    args.enter(action, callback)
    args.enter(action, callback)
    args.search(action, 'new login', callback)
    const item = {id: id(1), title: 'Login', searchKey: ['/new/project', 'Login']} as ProjectItemImpl
    resolveNew([item])
    await Promise.resolve()
    expect(callback).toHaveBeenLastCalledWith([item])
    const calls = callback.mock.calls.length
    resolveOld([])
    await Promise.resolve()
    expect(callback).toHaveBeenCalledTimes(calls)
})

test('entry distinguishes disabled, loading, empty and failed-directory states', async () => {
    const app = new ClaudeApplication()
    const args = new ClaudeArgs(app)
    const callback = jest.fn()
    args.enter(action, callback)
    expect(callback.mock.calls.at(-1)[0][0]).toMatchObject({id: 'claude-settings', title: i18n.t(sentenceKey.claudeEnable)})
    utools.dbStorage.setItem(app.enabledId(utools.getNativeId()), true)
    const generate = jest.spyOn(app, 'generateProjectItems').mockResolvedValue([])
    args.enter(action, callback)
    expect(callback.mock.calls.at(-1)[0][0].title).toBe(i18n.t(sentenceKey.claudeLoading))
    await Promise.resolve()
    expect(callback.mock.calls.at(-1)[0][0].title).toBe(i18n.t(sentenceKey.claudeEmpty))
    generate.mockRejectedValueOnce(new Error('EACCES'))
    args.enter(action, callback)
    await Promise.resolve()
    await Promise.resolve()
    expect(callback.mock.calls.at(-1)[0][0]).toMatchObject({id: 'claude-settings', title: i18n.t(sentenceKey.claudeDirectoryError)})
    expect(utools.copyText).not.toHaveBeenCalled()
})

test('legacy firstPrompt excludes injected markup', async () => {
    transcript(1, [])
    index([{sessionId: id(1), firstPrompt: '<ide_opened_file>Injected</ide_opened_file> User question'}])
    expect((await new SessionReader().read(root)).sessions[0].title).toBe('User question')
})
