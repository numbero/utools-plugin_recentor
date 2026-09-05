import {join} from 'path'
import {Context} from '../../Context'
import {i18n, sentenceKey} from '../../i18n'
import {
    ApplicationConfigImpl, ApplicationConfigState, DatetimeProjectItemImpl, Executor,
    GROUP_EDITOR, InputSettingItem, PLATFORM_ALL, SettingItem, SettingProperties,
} from '../../Types'
import {errorNotify, warnNotify} from '../../utils/log/NotificationLog'
import {SessionReader} from './SessionReader'

export class CopySessionIdExecutor implements Executor {
    constructor(readonly command: string) {}

    execute(context: Context): void {
        try {
            if (!this.command || utools.copyText(this.command) === false) throw new Error(i18n.t(sentenceKey.claudeCopyFailed))
        } catch {
            errorNotify(context, i18n.t(sentenceKey.claudeCopyFailed))
            return
        }
        utools.showNotification(i18n.t(sentenceKey.claudeCopied))
        if (context.enableOutPluginImmediately) {
            utools.hideMainWindow()
            utools.outPlugin()
        }
    }
}

export class ClaudeApplication extends ApplicationConfigImpl<DatetimeProjectItemImpl> {
    private reader = new SessionReader()
    private configuredPath = ''

    constructor() {
        super('claude-sessions', 'Claude Code', 'https://code.claude.com', 'icon/claude.png',
            'claude', PLATFORM_ALL, GROUP_EDITOR, () => i18n.t(sentenceKey.claudeDescription), false, '.claude')
    }

    override defaultConfigPath(): string {
        return process.env.CLAUDE_CONFIG_DIR?.trim() || join(utools.getPath('home'), '.claude')
    }

    override update(nativeId: string): void {
        super.update(nativeId)
        this.configuredPath = this.config.trim()
        this.config = this.configuredPath || this.defaultConfigPath()
    }

    override configSettingItemProperties(): SettingProperties {
        return {...super.configSettingItemProperties(), openFile: false, openDirectory: true}
    }

    override configSettingItem(context: Context, nativeId: string): SettingItem {
        return new InputSettingItem(this.configId(nativeId), i18n.t(sentenceKey.claudeDirectory), this.configuredPath,
            () => `${i18n.t(sentenceKey.claudeDirectoryHint)} ${this.defaultConfigPath()}`, this.configSettingItemProperties())
    }

    // Directory errors are reported by the dedicated list, with an actionable configuration message.
    override async isFinishConfig(context: Context): Promise<ApplicationConfigState> {
        return this.enabled ? ApplicationConfigState.done : ApplicationConfigState.empty
    }

    override async generateProjectItems(context: Context): Promise<DatetimeProjectItemImpl[]> {
        let result: Awaited<ReturnType<SessionReader['read']>>
        try { result = await this.reader.read(this.config) }
        catch { throw new Error(i18n.t(sentenceKey.claudeDirectoryError)) }
        if (result.partial) warnNotify(context, i18n.t(sentenceKey.claudePartial))
        return result.sessions.map(session => {
            const title = session.title || i18n.t(sentenceKey.claudeUnnamed)
            return {
                id: session.sessionId, title: title.replace(/\s+/g, ' ').trim(),
                description: session.projectPath || i18n.t(sentenceKey.claudeUnknownPath),
                icon: this.icon, searchKey: [title, session.projectPath], exists: true,
                command: new CopySessionIdExecutor(session.sessionId), datetime: session.modified,
            }
        })
    }
}
