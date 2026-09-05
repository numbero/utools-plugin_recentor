import {execFileSync} from 'child_process'
import {chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync} from 'fs'
import {tmpdir} from 'os'
import {dirname, join} from 'path'
import {pathToFileURL} from 'url'
import sqlInit from 'sql.js'
import {Vscode1640ApplicationImpl, VscodeApplicationImpl} from '../../../src/parser/editor/Vscode'
import {Context} from '../../../src/Context'
import {ApplicationConfigState} from '../../../src/Types'

const temporaryPaths: string[] = []
let cli: string

const createCli = (name = 'Visual Studio Code') => {
    const root = mkdtempSync(join(tmpdir(), 'vscode-cli-fixture-'))
    temporaryPaths.push(root)
    const path = join(root, `${name}.app`, 'Contents/Resources/app/bin/code')
    mkdirSync(dirname(path), {recursive: true})
    writeFileSync(path, '#!/bin/sh\nexit 0\n', {mode: 0o755})
    return path
}

beforeEach(() => { cli = createCli() })

const writeStateDatabase = async (path: string, entries?: object[]) => {
    const SQL = await sqlInit()
    const database = new SQL.Database()
    database.run('create table ItemTable (key text unique on conflict replace, value blob)')
    if (entries) {
        database.run(
            'insert into ItemTable (key, value) values (?, ?)',
            ['history.recentlyOpenedPathsList', JSON.stringify({entries})],
        )
    }
    mkdirSync(dirname(path), {recursive: true})
    writeFileSync(path, database.export())
    database.close()
}

afterEach(() => {
    jest.restoreAllMocks()
    temporaryPaths.splice(0).forEach(path => rmSync(path, {recursive: true, force: true}))
})

test('vscodeProjectItems', async () => {
    let app = new VscodeApplicationImpl()
    Object.assign(app, {config: `${__dirname}/storage.json`, executor: cli})

    let items = await app.generateProjectItems(Context.get())
    expect(items.length).toEqual(4)
    expect(items[0].title).toEqual('notes')
    expect(items[1].title).toEqual('notes')
    expect(items[2].title).toEqual('notes-server')
    expect(items[3].title).toEqual('notes')
})

test('reads recent projects from the VS Code 1.118 shared storage database', async () => {
    const home = mkdtempSync(join(tmpdir(), 'vscode-history-'))
    temporaryPaths.push(home)
    jest.spyOn(utools, 'getPath').mockReturnValue(home)
    const legacyDatabase = join(home, 'Library/Application Support/Code/User/globalStorage/state.vscdb')
    const sharedDatabase = join(home, '.vscode-shared/sharedStorage/state.vscdb')
    await writeStateDatabase(legacyDatabase)
    await writeStateDatabase(sharedDatabase, [{folderUri: 'file:///tmp/current-project'}])
    const app = new Vscode1640ApplicationImpl()
    Object.assign(app, {config: legacyDatabase, executor: cli})

    const items = await app.generateProjectItems(Context.get())

    expect(items.map(item => item.title)).toEqual(['current-project'])
    expect(app.defaultConfigPath()).toBe(sharedDatabase)

    await writeStateDatabase(sharedDatabase, [{folderUri: 'file:///tmp/current-project-renamed'}])
    const updatedItems = await app.generateProjectItems(Context.get())

    expect(updatedItems.map(item => item.title)).toEqual(['current-project-renamed'])
})

test('refreshes cached commands when the VS Code executor changes', async () => {
    const home = mkdtempSync(join(tmpdir(), 'vscode-executor-'))
    temporaryPaths.push(home)
    jest.spyOn(utools, 'getPath').mockReturnValue(home)
    const sharedDatabase = join(home, '.vscode-shared/sharedStorage/state.vscdb')
    await writeStateDatabase(sharedDatabase, [{folderUri: 'file:///tmp/current-project'}])
    const app = new Vscode1640ApplicationImpl()
    Object.assign(app, {config: sharedDatabase, executor: cli})

    const staleItems = await app.generateProjectItems(Context.get())
    const updatedCli = createCli('Updated Code')
    Object.assign(app, {executor: updatedCli})
    const refreshedItems = await app.generateProjectItems(Context.get())

    expect(staleItems[0].command.command).toContain(cli)
    expect(refreshedItems[0].command.command).toContain(updatedCli)
})

test.each([
    ['app bundle', (...parts: string[]) => join(...parts)],
    ['app executable', (...parts: string[]) => join(...parts, 'Contents', 'MacOS', 'Code')],
])('rejects the %s instead of falling back to macOS Launch Services', async (_description, executorPath) => {
    const home = mkdtempSync(join(tmpdir(), 'vscode-macos-executor-'))
    temporaryPaths.push(home)
    jest.spyOn(utools, 'getPath').mockReturnValue(home)
    const sharedDatabase = join(home, '.vscode-shared/sharedStorage/state.vscdb')
    await writeStateDatabase(sharedDatabase, [{folderUri: 'file:///tmp/current-project'}])
    const app = new Vscode1640ApplicationImpl()
    const appPath = join(home, 'Visual Studio Code.app')
    Object.assign(app, {
        config: sharedDatabase,
        executor: executorPath(appPath),
        openInNew: true,
    })

    await expect(app.generateProjectItems(Context.get())).rejects.toThrow('CLI')
})

const adapters = [
    ['legacy history', () => new VscodeApplicationImpl()],
    ['current history', () => new Vscode1640ApplicationImpl()],
] as const

test.each(adapters)('always shows the CLI window setting in %s', (_description, createApplication) => {
    const nativeId = 'native-id'
    const app = createApplication()

    for (const executor of ['', '/Applications/Visual Studio Code.app', '/Applications/Visual Studio Code.app/Contents/MacOS/Code']) {
        Object.assign(app, {executor})
        expect(app.generateSettingItems(Context.get(), nativeId).map(setting => setting.id)).toContain(app.openInNewId(nativeId))
    }

    for (const executor of [app.defaultExecutorPath(), '/usr/local/bin/code']) {
        Object.assign(app, {executor})
        expect(app.generateSettingItems(Context.get(), nativeId).map(setting => setting.id)).toContain(app.openInNewId(nativeId))
    }

    Object.assign(app, {isMacOs: false})
    const nonMacSettings = app.generateSettingItems(Context.get(), nativeId)

    expect(nonMacSettings.map(setting => setting.id)).toContain(app.openInNewId(nativeId))
})

test.each([true, false])('honors the CLI window preference (%s) on macOS for local and remote folders', async openInNew => {
    const home = mkdtempSync(join(tmpdir(), 'vscode-cli-'))
    temporaryPaths.push(home)
    const database = join(home, 'state.vscdb')
    await writeStateDatabase(database, [
        {folderUri: 'file:///tmp/current-project'},
        {folderUri: 'vscode-remote://ssh-remote+example/tmp/remote-project'},
    ])
    const executor = cli
    const app = new Vscode1640ApplicationImpl()
    Object.assign(app, {config: database, executor, openInNew})

    const items = await app.generateProjectItems(Context.get())
    const flag = openInNew ? '--new-window' : '--reuse-window'

    expect(items[0].command.command).toBe(`'${executor}' ${flag} '/tmp/current-project'`)
    expect(items[1].command.command).toBe(`'${executor}' ${flag} --folder-uri 'vscode-remote://ssh-remote+example/tmp/remote-project'`)
})

test.each(adapters)('retains the window preference while correcting the configured path in %s', (_description, createApplication) => {
    const app = createApplication()
    let executor = app.defaultExecutorPath()
    jest.spyOn(utools.dbStorage, 'getItem').mockImplementation(key => {
        if (key === app.executorId('test')) return executor
        if (key === app.openInNewId('test')) return true
        return null
    })
    app.update('test')
    expect((app as any).openInNew).toBe(true)
    executor = '/Applications/Visual Studio Code.app'
    app.update('test')
    expect((app as any).openInNew).toBe(true)
})

test('refreshes legacy cached commands after changing the launcher or window preference', async () => {
    const app = new VscodeApplicationImpl()
    Object.assign(app, {config: `${__dirname}/storage.json`, executor: cli, openInNew: false})
    const original = await app.generateProjectItems(Context.get())
    Object.assign(app, {openInNew: true})
    const newWindow = await app.generateProjectItems(Context.get())
    expect(newWindow[0].command.command).toContain('--new-window')
    expect(newWindow[0].command.command).not.toBe(original[0].command.command)
    Object.assign(app, {executor: '/Applications/Visual Studio Code.app'})
    await expect(app.generateProjectItems(Context.get())).rejects.toThrow('CLI')
    await expect(app.generateProjectItems(Context.get())).rejects.toThrow('CLI')
})

test('quotes macOS CLI paths and workspace arguments literally', async () => {
    const home = mkdtempSync(join(tmpdir(), 'vscode-quoted-cli-'))
    temporaryPaths.push(home)
    const database = join(home, 'state.vscdb')
    const target = "/tmp/project's $(printf unexpected) $HOME.code-workspace"
    const executor = createCli("Editor's Code")
    await writeStateDatabase(database, [{workspace: {configPath: pathToFileURL(target).href}}])
    const app = new Vscode1640ApplicationImpl()
    Object.assign(app, {config: database, executor, openInNew: true})
    const [item] = await app.generateProjectItems(Context.get())

    expect(item.command.command).toContain("'\\''")
    if (process.platform !== 'win32') {
        // Parse only; never run the launcher. Shell expansion must not alter either argument.
        const parsed = execFileSync('/bin/sh', ['-c', `set -- ${item.command.command}; printf '%s\\n' "$@"`], {encoding: 'utf8'})
        expect(parsed.trimEnd().split('\n')).toEqual([executor, '--new-window', target])
    }
})

test('preserves Windows launch commands', async () => {
    const home = mkdtempSync(join(tmpdir(), 'vscode-windows-cli-'))
    temporaryPaths.push(home)
    const database = join(home, 'state.vscdb')
    await writeStateDatabase(database, [{folderUri: 'file:///C:/Projects/example'}])
    const app = new Vscode1640ApplicationImpl()
    Object.assign(app, {config: database, executor: 'C:/VSCode/Code.exe', isMacOs: false, isWindows: true, openInNew: true})
    const [item] = await app.generateProjectItems(Context.get())
    expect(item.command.command).toBe('"C:/VSCode/Code.exe" -n "C:/Projects/example"')
})

test.each(adapters)('validates the CLI file and its symlinks in %s', async (_description, createApplication) => {
    const app = createApplication()
    Object.assign(app, {enabled: true, config: `${__dirname}/storage.json`, executor: cli})
    expect(await app.isFinishConfig(Context.get())).toBe(ApplicationConfigState.done)

    const link = join(dirname(cli), 'cli-link')
    symlinkSync(cli, link, 'file')
    Object.assign(app, {executor: link})
    expect(await app.isFinishConfig(Context.get())).toBe(ApplicationConfigState.done)

    for (const executor of [dirname(cli), cli.replace('/Resources/app/bin/code', '/MacOS/Code'), 'code', `${cli}-missing`]) {
        Object.assign(app, {executor})
        expect(await app.isFinishConfig(Context.get())).toBe(ApplicationConfigState.error)
        await expect(app.generateProjectItems(Context.get())).rejects.toThrow('CLI')
    }

    // A link named "code" does not make the GUI binary a CLI.
    const gui = join(dirname(cli), 'gui-binary')
    writeFileSync(gui, '', {mode: 0o755})
    unlinkSync(link)
    symlinkSync(gui, link, 'file')
    Object.assign(app, {executor: link})
    expect(await app.isFinishConfig(Context.get())).toBe(ApplicationConfigState.error)

    Object.assign(app, {executor: cli})
    if (process.platform !== 'win32') {
        chmodSync(cli, 0o644)
        expect(await app.isFinishConfig(Context.get())).toBe(ApplicationConfigState.error)
    }
    unlinkSync(cli)
    expect(await app.isFinishConfig(Context.get())).toBe(ApplicationConfigState.error)
})

test.each(adapters)('explains the required CLI path beside the setting in %s', (_description, createApplication) => {
    const app = createApplication()
    Object.assign(app, {executor: '/Applications/Visual Studio Code.app'})
    const item = app.executorSettingItem(Context.get(), 'test')
    const description = typeof item.description === 'function' ? item.description() : item.description
    expect(item.name).toContain('CLI')
    expect(description).toContain('/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code')
    expect(description).toContain('Contents/MacOS/Code')
    expect(description).toContain('⌘⇧G')
    expect(item.properties.treatPackageAsDirectory).toBe(true)
    expect(item.properties.openDirectory).toBe(false)
    Object.assign(app, {isMacOs: false})
    expect(app.executorSettingItem(Context.get(), 'test').name).not.toContain('CLI')
})

test('does not reuse cached projects after the CLI is removed', async () => {
    const home = mkdtempSync(join(tmpdir(), 'vscode-cli-cache-'))
    temporaryPaths.push(home)
    const config = join(home, 'state.vscdb')
    await writeStateDatabase(config, [{folderUri: 'file:///tmp/current-project'}])
    const app = new Vscode1640ApplicationImpl()
    Object.assign(app, {config, executor: cli})
    expect(await app.generateProjectItems(Context.get())).toHaveLength(1)
    unlinkSync(cli)
    await expect(app.generateProjectItems(Context.get())).rejects.toThrow('CLI')
    await expect(app.generateProjectItems(Context.get())).rejects.toThrow('CLI')
})
