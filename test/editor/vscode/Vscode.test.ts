import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'fs'
import {tmpdir} from 'os'
import {dirname, join} from 'path'
import sqlInit from 'sql.js'
import {Vscode1640ApplicationImpl, VscodeApplicationImpl} from '../../../src/parser/editor/Vscode'
import {Context} from '../../../src/Context'

const temporaryPaths: string[] = []

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
    Object.assign(app, {config: `${__dirname}/storage.json`})

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
    Object.assign(app, {config: legacyDatabase, executor: '/usr/local/bin/code'})

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
    Object.assign(app, {config: sharedDatabase, executor: '/old/code'})

    const staleItems = await app.generateProjectItems(Context.get())
    Object.assign(app, {executor: '/new/code'})
    const refreshedItems = await app.generateProjectItems(Context.get())

    expect(staleItems[0].command.command).toContain('/old/code')
    expect(refreshedItems[0].command.command).toContain('/new/code')
})

test('uses the CLI launcher when the macOS app executable is configured', async () => {
    const home = mkdtempSync(join(tmpdir(), 'vscode-macos-executor-'))
    temporaryPaths.push(home)
    jest.spyOn(utools, 'getPath').mockReturnValue(home)
    const sharedDatabase = join(home, '.vscode-shared/sharedStorage/state.vscdb')
    await writeStateDatabase(sharedDatabase, [{folderUri: 'file:///tmp/current-project'}])
    const app = new Vscode1640ApplicationImpl()
    const appPath = join(home, 'Visual Studio Code.app')
    Object.assign(app, {
        config: sharedDatabase,
        executor: join(appPath, 'Contents', 'MacOS', 'Code'),
    })

    const items = await app.generateProjectItems(Context.get())

    expect(items[0].command.command).toContain(join(appPath, 'Contents', 'Resources', 'app', 'bin', 'code'))
    expect(items[0].command.command).not.toContain(join('Contents', 'MacOS', 'Code'))
})
