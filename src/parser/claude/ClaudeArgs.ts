import S from 'licia/$'
import {Context} from '../../Context'
import {i18n, sentenceKey} from '../../i18n'
import {Action, Callback, NoExecutor, ProjectArgsImpl, ProjectItemImpl} from '../../Types'
import {ClaudeApplication} from './Claude'

export class ClaudeArgs extends ProjectArgsImpl {
    private requestId = 0
    private query = ''
    private status: ProjectItemImpl | undefined

    constructor(private readonly application: ClaudeApplication = new ClaudeApplication()) {
        super([application])
    }

    get placeholder(): string { return i18n.t(sentenceKey.claudeSearch) }

    private tip(title: string, description = '', settings = false): ProjectItemImpl {
        return {id: settings ? 'claude-settings' : 'claude-status', title, description,
            icon: 'info.png', searchKey: [], exists: true, command: new NoExecutor()}
    }

    override enter(action: Action, callback: Callback<ProjectItemImpl>): void {
        super.enter(action, callback)
        S('.container').css('display', 'none')
        S('style.custom').each((index, element) => element.remove())
        const request = ++this.requestId
        this.clearCache()
        this.query = ''
        this.status = this.tip(i18n.t(sentenceKey.claudeLoading))
        callback([this.status])
        this.application.update(utools.getNativeId())
        if (!this.application.enabled) {
            this.status = this.tip(i18n.t(sentenceKey.claudeEnable), i18n.t(sentenceKey.claudeSettingsHint), true)
            callback([this.status])
            return
        }
        this.application.generateProjectItems(this.context!)
            .then(items => {
                if (request !== this.requestId) return
                this.projectItemCache = items
                this.status = items.length ? undefined : this.tip(i18n.t(sentenceKey.claudeEmpty))
                this.search(action, this.query, callback)
            })
            .catch(() => {
                if (request !== this.requestId) return
                this.status = this.tip(i18n.t(sentenceKey.claudeDirectoryError), i18n.t(sentenceKey.claudeSettingsHint), true)
                callback([this.status])
            })
    }

    search = (action: Action, searchText: string, callback: Callback<ProjectItemImpl>): void => {
        this.query = searchText
        if (this.status) { callback([this.status]); return }
        const terms = searchText.toLowerCase().trim().split(/\s+/).filter(Boolean)
        const items = this.projectItemCache.filter(item => terms.every(term =>
            item.searchKey.some(key => key.toLowerCase().includes(term))))
        callback(items.length ? items : [this.tip(i18n.t(sentenceKey.claudeNoMatch))])
    }

    select = (action: Action, item: ProjectItemImpl, callback: Callback<ProjectItemImpl>): void => {
        if (item.id === 'claude-settings') { utools.redirect('Setting', ''); return }
        item.command.execute(this.context ?? Context.get())
    }
}
