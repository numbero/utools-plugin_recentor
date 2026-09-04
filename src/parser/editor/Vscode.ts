import {existsSync} from 'fs'
import {readFile, stat} from 'fs/promises'
import {isEmpty, isNil, startWith, unique, Url} from 'licia'
import {join, normalize, parse} from 'path'
import {Context} from '../../Context'
import {i18n, sentenceKey} from '../../i18n'
import {
    ApplicationCacheConfigAndExecutorImpl,
    ApplicationConfigState,
    ApplicationImpl,
    DatetimeProjectItemImpl,
    GROUP_EDITOR,
    PLATFORM_ALL,
    SettingItem,
    SettingProperties,
    ShellExecutor,
    SwitchSettingItem,
} from '../../Types'
import {configExtensionFilter, existsOrNot, generateStringByOS, systemUser} from '../../Utils'
import {generateFilePathIndex} from '../../utils/index-generator/FilePathIndex'
import {generatePinyinIndex} from '../../utils/index-generator/PinyinIndex'
import {queryFromSqlite} from '../../utils/sqlite/SqliteExecutor'

const VSCODE: string = 'vscode'
const VSCODE_1640: string = 'vscode-1640'
const HOMEPAGE: string = 'https://code.visualstudio.com/'

export class VscodeProjectItemImpl extends DatetimeProjectItemImpl {}

const resolveExecutor = (executor: string, isMacOs: boolean): string => {
    const parsed = parse(normalize(executor))
    if (isMacOs && parsed.base === 'Code' && parsed.dir.endsWith(join('Contents', 'MacOS'))) {
        return join(parsed.dir, '..', 'Resources', 'app', 'bin', 'code')
    }
    return executor
}

const parseEntries: (entries: any, context: Context, openInNew: boolean, isWindows: boolean, isMacOs: boolean, icon: string, executor: string, sortByAccessTime: boolean | undefined) => Promise<Array<VscodeProjectItemImpl>> = async (entries, context, openInNew, isWindows, isMacOs, defaultIcon, executor, sortByAccessTime) => {
    let items: Array<VscodeProjectItemImpl> = []
    if (!isNil(entries)) {
        let args = openInNew ? '-n' : ''
        const resolvedExecutor = resolveExecutor(executor, isMacOs)
        for (let element of entries) {
            let folderUri = element['folderUri'],
                fileUri = element['fileUri'],
                workspace = element['workspace'],
                uri
            if (!isEmpty(folderUri)) {
                uri = folderUri
            } else if (!isEmpty(fileUri)) {
                uri = fileUri
            } else if (!isNil(workspace)) {
                let configPath = workspace['configPath'] ?? ''
                if (!isEmpty(configPath)) {
                    uri = configPath
                } else {
                    continue
                }
            } else {
                continue
            }
            let uriParsed = decodeURIComponent(uri)
            let urlParsed = Url.parse(uriParsed)
            let path = urlParsed.pathname
            if (isWindows) {
                path = path.substring(1)
            }
            let parser = parse(path)
            let { exists, description, icon } = existsOrNot(path, {
                description: path,
                icon: context.enableGetFileIcon ? utools.getFileIcon(path) : defaultIcon,
            })

            let commandText = `"${resolvedExecutor}" ${args} "${path}"`

            // 对 remote folder 进行处理
            if (startWith(uri, 'vscode-remote')) {
                let label = element['label'] ?? uriParsed
                exists = true
                description = label
                commandText = `"${resolvedExecutor}" --folder-uri "${uriParsed}"`
            }

            let accessTime = 0
            if (sortByAccessTime && exists) {
                try {
                    accessTime = (await stat(path)).atimeMs
                } catch (error) {
                    console.error('Get accessTime failure', path, error)
                }
            }

            items.push({
                id: '',
                title: parser.name,
                description: description,
                icon: icon,
                searchKey: unique([
                    ...generatePinyinIndex(context, parser.name),
                    ...generateFilePathIndex(context, path),
                    parser.name,
                ]),
                exists: exists,
                command: new ShellExecutor(commandText),
                datetime: accessTime,
            })
        }
    }
    return items
}

export class VscodeApplicationImpl extends ApplicationCacheConfigAndExecutorImpl<VscodeProjectItemImpl> {
    private openInNew: boolean = false
    private isWindows: boolean = utools.isWindows()
    private isMacOs: boolean = utools.isMacOS()

    constructor() {
        super(
            VSCODE,
            'Visual Studio Code (< 1.64.0)',
            HOMEPAGE,
            'icon/ms-visual-studio-code.png',
            VSCODE,
            PLATFORM_ALL,
            GROUP_EDITOR,
            () => `1.64.0 版本之前的旧版本需要单独配置, ${i18n.t(sentenceKey.configFileAt)} ${this.defaultConfigPath()}, ${i18n.t(sentenceKey.executorFileAt)} ${this.defaultExecutorPath()}`,
            undefined,
            'storage.json',
        )
    }

    override defaultConfigPath(): string {
        return generateStringByOS({
            win32: `C:\\Users\\${systemUser()}\\AppData\\Roaming\\Code\\storage.json`,
            darwin: `/Users/${systemUser()}/Library/Application Support/Code/storage.json`,
            linux: `/home/${systemUser()}/.config/Code/storage.json`,
        })
    }

    override defaultExecutorPath(): string {
        return generateStringByOS({
            win32: `C:\\Users\\${systemUser()}\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe`,
            darwin: '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
            linux: '(不同发行版安装路径差异较大, 自行使用 which 命令找到 code 命令所在路径作为可执行文件路径)',
        })
    }

    override configSettingItemProperties(): SettingProperties {
        return {
            ...super.configSettingItemProperties(),
            filters: configExtensionFilter('json'),
        }
    }

    async generateCacheProjectItems(context: Context): Promise<Array<VscodeProjectItemImpl>> {
        let items: Array<VscodeProjectItemImpl> = []
        let buffer = await readFile(this.config)
        if (!isNil(buffer)) {
            let content = buffer.toString()
            let storage = JSON.parse(content)
            let entries = storage?.openedPathsList?.entries
            items.push(...(await parseEntries(entries, context, this.openInNew, this.isWindows, this.isMacOs, this.icon, this.executor, undefined)))
        }
        return items
    }

    openInNewId(nativeId: string) {
        return `${nativeId}/${this.id}-open-in-new`
    }

    override update(nativeId: string) {
        super.update(nativeId)
        this.openInNew = utools.dbStorage.getItem(this.openInNewId(nativeId)) ?? false
    }

    override generateSettingItems(context: Context, nativeId: string): Array<SettingItem> {
        let superSettings = super.generateSettingItems(context, nativeId)
        superSettings.splice(0, 0, new SwitchSettingItem(
            this.openInNewId(nativeId),
            i18n.t(sentenceKey.openInNew),
            this.openInNew,
            i18n.t(sentenceKey.openInNewDesc),
        ))
        return superSettings
    }
}

export class Vscode1640ApplicationImpl extends ApplicationCacheConfigAndExecutorImpl<VscodeProjectItemImpl> {
    private openInNew: boolean = false
    private sortByAccessTime: boolean = false
    private isWindows: boolean = utools.isWindows()
    private isMacOs: boolean = utools.isMacOS()
    private databaseSignature: string = ''
    private hasLoadedDatabase: boolean = false

    constructor() {
        super(
            VSCODE_1640,
            'Visual Studio Code',
            HOMEPAGE,
            'icon/ms-visual-studio-code.png',
            VSCODE_1640,
            PLATFORM_ALL,
            GROUP_EDITOR,
            () => `${i18n.t(sentenceKey.configFileAt)} ${this.defaultConfigPath()}, ${i18n.t(sentenceKey.executorFileAt)} ${this.defaultExecutorPath()}`,
            undefined,
            'state.vscdb',
        )
    }

    override defaultConfigPath(): string {
        return join(utools.getPath('home'), '.vscode-shared', 'sharedStorage', 'state.vscdb')
    }

    private legacyConfigPath(): string {
        const home = utools.getPath('home')
        return generateStringByOS({
            win32: join(home, 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'state.vscdb'),
            darwin: join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'state.vscdb'),
            linux: join(home, '.config', 'Code', 'User', 'globalStorage', 'state.vscdb'),
        })
    }

    private databasePaths(): string[] {
        const shared = this.defaultConfigPath()
        const legacy = this.legacyConfigPath()
        const configuredIsLegacy = !isEmpty(this.config) && normalize(this.config) === normalize(legacy)
        const paths = configuredIsLegacy
            ? [shared, this.config, legacy]
            : [this.config, shared, legacy]
        return unique(paths.filter(path => !isEmpty(path)))
    }

    override defaultExecutorPath(): string {
        return generateStringByOS({
            win32: `C:\\Users\\${systemUser()}\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe`,
            darwin: '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
            linux: '(不同发行版安装路径差异较大, 自行使用 which 命令找到 code 命令所在路径作为可执行文件路径)',
        })
    }

    override configSettingItemProperties(): SettingProperties {
        return {
            ...super.configSettingItemProperties(),
            filters: configExtensionFilter('vscdb'),
        }
    }

    override async isFinishConfig(context: Context): Promise<ApplicationConfigState> {
        if (this.disEnable()) return ApplicationConfigState.empty
        if (isEmpty(this.executor)) return ApplicationConfigState.undone
        if (this.databasePaths().some(path => existsSync(path))) return ApplicationConfigState.done
        return isEmpty(this.config) ? ApplicationConfigState.undone : ApplicationConfigState.error
    }

    override async isNew(): Promise<boolean> {
        const signatures = await Promise.all(this.databasePaths().flatMap(path => [path, `${path}-wal`]).map(async path => {
            try {
                const info = await stat(path)
                return `${path}:${info.size}:${info.mtimeMs}`
            } catch {
                return `${path}:missing`
            }
        }))
        const signature = [
            ...signatures,
            `executor:${this.executor}`,
            `openInNew:${this.openInNew}`,
            `sortByAccessTime:${this.sortByAccessTime}`,
        ].join('|')
        const changed = !this.hasLoadedDatabase || signature !== this.databaseSignature
        this.hasLoadedDatabase = true
        this.databaseSignature = signature
        return changed
    }

    async generateCacheProjectItems(context: Context): Promise<Array<VscodeProjectItemImpl>> {
        let lastError: unknown
        for (const databasePath of this.databasePaths()) {
            if (!existsSync(databasePath)) continue
            try {
                // language=SQLite
                let results = await queryFromSqlite(databasePath, 'select value as result from ItemTable where key = \'history.recentlyOpenedPathsList\'')
                if (!isEmpty(results)) {
                    let row = results[0]
                    let source = row['result'] as string
                    if (!isEmpty(source)) {
                        return await parseEntries(JSON.parse(source)['entries'], context, this.openInNew, this.isWindows, this.isMacOs, this.icon, this.executor, this.sortByAccessTime)
                    }
                }
            } catch (error) {
                lastError = error
            }
        }
        if (!isNil(lastError)) throw lastError
        return []
    }

    openInNewId(nativeId: string) {
        return `${nativeId}/${this.id}-open-in-new`
    }

    private sortByAccessTimeId(nativeId: string) {
        return `${nativeId}/${this.id}-sort-by-access-time`
    }

    override update(nativeId: string) {
        super.update(nativeId)
        this.openInNew = utools.dbStorage.getItem(this.openInNewId(nativeId)) ?? false
        this.sortByAccessTime = utools.dbStorage.getItem(this.sortByAccessTimeId(nativeId)) ?? false
    }

    override generateSettingItems(context: Context, nativeId: string): Array<SettingItem> {
        let superSettings = super.generateSettingItems(context, nativeId)
        superSettings.splice(0, 0, new SwitchSettingItem(
            this.openInNewId(nativeId),
            i18n.t(sentenceKey.openInNew),
            this.openInNew,
            i18n.t(sentenceKey.openInNewDesc),
        ))
        superSettings.splice(1, 0, new SwitchSettingItem(
            this.sortByAccessTimeId(nativeId),
            i18n.t(sentenceKey.sortByAccessTime),
            this.sortByAccessTime,
            i18n.t(sentenceKey.sortByAccessTimeDesc),
        ))
        return superSettings
    }
}

export const applications: Array<ApplicationImpl<VscodeProjectItemImpl>> = [
    new Vscode1640ApplicationImpl(),
    new VscodeApplicationImpl(),
]
