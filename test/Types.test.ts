import {shell} from 'electron'
import {Context} from '../src/Context'
import {
    ApplicationConfigState,
    ApplicationImpl,
    ElectronPathExecutor,
    NoExecutor,
    PLATFORM_ALL,
    ProjectArgsImpl,
    ProjectItemImpl,
} from '../src/Types'

class TestItem extends ProjectItemImpl {
    constructor(title: string) {
        super(title, title, title, '', [title], true, new NoExecutor())
    }
}

class TestApplication extends ApplicationImpl<TestItem> {
    constructor(name: string, private readonly generate: () => Promise<TestItem[]>) {
        super(name, name, '', '', name, PLATFORM_ALL)
    }

    override update(): void {
        this.enabled = true
    }

    override async isFinishConfig(): Promise<ApplicationConfigState> {
        return ApplicationConfigState.done
    }

    override generateProjectItems(): Promise<TestItem[]> {
        return this.generate()
    }
}

class TestProjectArgs extends ProjectArgsImpl {
    readonly placeholder = ''
    search = () => undefined
    select = () => undefined

    cachedTitles(): string[] {
        return this.projectItemCache.map(item => item.title)
    }
}

const context = (enableOutPluginImmediately: boolean) => ({
    enableOutPluginImmediately,
    isDev: false,
}) as Context

beforeEach(() => {
    jest.clearAllMocks()
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
    jest.restoreAllMocks()
})

test('does not show an empty notification after opening a path successfully', async () => {
    jest.mocked(shell.openPath).mockResolvedValue('')

    new ElectronPathExecutor('/tmp/file').execute(context(false))
    await Promise.resolve()

    expect(utools.showNotification).not.toHaveBeenCalled()
    expect(utools.outPlugin).not.toHaveBeenCalled()
})

test('reports a path open failure as an error', async () => {
    jest.mocked(shell.openPath).mockResolvedValue('Unable to open path')

    new ElectronPathExecutor('/tmp/file').execute(context(false))
    await Promise.resolve()

    expect(utools.showNotification).toHaveBeenCalledWith('[Error] Unable to open path')
})

test('keeps successful adapter results and reports a failed adapter', async () => {
    const successful = new TestApplication('working', async () => [new TestItem('project')])
    const failing = new TestApplication('broken', async () => {
        throw new Error('parse failed')
    })
    const args = new TestProjectArgs([successful, failing])

    const first = await args.getProjectItems('native-id')
    const second = await args.getProjectItems('native-id')

    expect(first.map(item => item.title)).toEqual(['project'])
    expect(second.map(item => item.title)).toEqual(['project'])
    expect(utools.showNotification).toHaveBeenCalledWith(expect.stringContaining('broken'))
    expect(utools.showNotification).toHaveBeenCalledWith(expect.stringContaining('parse failed'))
})

test('does not let an older load replace the latest cache', async () => {
    let resolveFirst: (items: TestItem[]) => void = () => undefined
    const firstResult = new Promise<TestItem[]>(resolve => {
        resolveFirst = resolve
    })
    let loadCount = 0
    const application = new TestApplication('projects', async () => {
        loadCount++
        return loadCount === 1 ? firstResult : [new TestItem('latest')]
    })
    const args = new TestProjectArgs([application])

    const olderLoad = args.getProjectItems('native-id')
    await args.getProjectItems('native-id')
    resolveFirst([new TestItem('older')])
    await olderLoad

    expect(args.cachedTitles()).toEqual(['latest'])
})
