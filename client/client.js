// dsh-plugin-version-management — client bundle (hand-written ModuleLoader form,
// no bundler needed). Registers the "插件版本恢复" settings section and talks
// to the host through the /dsh-pvm/* HTTP routes.
window.__ModuleLoader__.load({ id: 'dsh-plugin-version-management', factory: function (require) {
  var module = { exports: {} }
  var exports = module.exports
  var React = require('react')

  var CSS = [
    '.dshpvm-root { display:flex; flex-direction:column; gap:12px; padding:4px 0; font-size:13px; }',
    '.dshpvm-card { border:1px solid rgba(128,128,128,.35); border-radius:8px; padding:10px 12px; }',
    '.dshpvm-card h3 { margin:0 0 8px; font-size:13px; font-weight:600; opacity:.92; }',
    '.dshpvm-row { display:flex; align-items:center; gap:8px; padding:3px 0; flex-wrap:wrap; }',
    '.dshpvm-table { width:100%; border-collapse:collapse; font-size:12px; }',
    '.dshpvm-table td, .dshpvm-table th { text-align:left; padding:3px 6px; border-bottom:1px solid rgba(128,128,128,.18); }',
    '.dshpvm-btn { padding:4px 10px; border-radius:6px; border:1px solid rgba(128,128,128,.45); background:transparent; cursor:pointer; font-size:12px; color:inherit; }',
    '.dshpvm-btn:hover { background:rgba(128,128,128,.12); }',
    '.dshpvm-btn:disabled { opacity:.45; cursor:default; }',
    '.dshpvm-btn.primary { background:rgba(64,128,255,.16); border-color:rgba(64,128,255,.6); }',
    '.dshpvm-msg { white-space:pre-wrap; font-family:Consolas,Menlo,monospace; font-size:11.5px; background:rgba(128,128,128,.08); border-radius:6px; padding:8px 10px; max-height:220px; overflow:auto; }',
    '.dshpvm-pre { white-space:pre-wrap; font-family:Consolas,Menlo,monospace; font-size:11px; max-height:260px; overflow:auto; background:rgba(128,128,128,.06); border-radius:6px; padding:8px; }',
    '.dshpvm-muted { opacity:.65; font-size:11.5px; }',
    '.dshpvm-changes { list-style:none; margin:6px 0; padding:0; max-height:200px; overflow:auto; }',
    '.dshpvm-changes li { padding:2px 0; font-size:12px; }',
  ].join('\n')

  async function api(name, body) {
    var res
    if (body === undefined) {
      res = await fetch('/dsh-pvm/' + name, { cache: 'no-store' })
    } else {
      res = await fetch('/dsh-pvm/' + name, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    }
    return await res.json()
  }

  function VersionPanel(props) {
    var plugins = React.useState(null)
    var snapshots = React.useState(null)
    var message = React.useState('')
    var busy = React.useState(false)
    var preview = React.useState(null)
    var checked = React.useState(null)
    var status = React.useState(null)
    var viewing = React.useState(null)
    var pollRef = React.useRef(null)
    var setPlugins = plugins[1]
    var setSnapshots = snapshots[1]
    var setMessage = message[1]
    var setBusy = busy[1]
    var setPreview = preview[1]
    var setChecked = checked[1]
    var setStatus = status[1]
    var setViewing = viewing[1]

    async function refresh() {
      setBusy(true)
      try {
        var p = await api('list-plugins')
        if (p && p.ok) setPlugins(p.info)
        var s = await api('list-snapshots')
        if (s && s.ok) setSnapshots(s.snapshots || [])
      } catch (e) {
        setMessage('refresh failed: ' + String((e && e.message) || e))
      }
      setBusy(false)
    }

    React.useEffect(function () {
      refresh()
    }, [])

    async function doSnapshot() {
      setBusy(true)
      setMessage('creating snapshot...')
      try {
        var r = await api('create-snapshot', {})
        if (r && r.ok) {
          setMessage('快照已生成：' + r.folderName + '（' + r.pluginCount + ' 个插件）\n文件夹：' + r.folderPath + '\n内含：JSON + TXT + 离线恢复脚本')
          await refresh()
        } else setMessage('snapshot failed: ' + (r && r.error))
      } catch (e) {
        setMessage('snapshot failed: ' + String((e && e.message) || e))
      }
      setBusy(false)
    }

    async function doPreview(src) {
      setBusy(true)
      setMessage('parsing snapshot...')
      try {
        var r = await api('restore-preview', src)
        if (r && r.ok) {
          setPreview(r)
          setChecked(null)
          setMessage('快照解析完成：' + r.snapshotCount + ' 个插件，与当前状态有 ' + r.changes.length + ' 处差异')
        } else {
          setPreview(null)
          setMessage('parse failed: ' + (r && r.error))
        }
      } catch (e) {
        setMessage('parse failed: ' + String((e && e.message) || e))
      }
      setBusy(false)
    }

    async function doApply(names) {
      if (!preview[0]) return
      setBusy(true)
      setMessage('starting restore...')
      try {
        var r = await api('restore-apply', { source: 'folder', folder: preview[0].folder, names: names })
        if (r && r.ok === false) {
          setMessage('restore failed: ' + String(r.error || JSON.stringify(r)))
        } else if (r && r.ok) {
          if (r.status === 'noop') {
            setMessage(r.message || 'no changes needed')
            setPreview(null)
          } else {
            setMessage('restore started: ' + r.changes.length + ' change(s). backup: ' + r.backupPath)
            setStatus({ running: true })
            startPolling()
          }
        } else {
          setMessage('restore failed: ' + JSON.stringify(r))
        }
      } catch (e) {
        setMessage('restore failed: ' + String((e && e.message) || e))
      }
      setBusy(false)
    }

    function startPolling() {
      if (pollRef.current) window.clearInterval(pollRef.current)
      var iv = window.setInterval(async function () {
        try {
          var st = await api('restore-status')
          setStatus(st)
          if (!st || st.running === false) {
            window.clearInterval(iv)
            setStatus(null)
            var extra = ''
            if (st && st.error) extra += '\n\nerror: ' + st.error
            if (st && st.logTail) extra += '\n\ninstall log tail:\n' + st.logTail
            if (st && st.exitCode === 0) setMessage('恢复完成。请重启 DSH 生效。' + extra)
            else setMessage('恢复未完全成功（退出码 ' + (st && st.exitCode) + '）。请检查日志，必要时用快照目录里的离线脚本重试。' + extra)
            refresh()
          }
        } catch (e) {
          window.clearInterval(iv)
          setStatus(null)
          setMessage('status poll failed: ' + String((e && e.message) || e))
        }
      }, 2000)
      pollRef.current = iv
    }

    async function doView(folder) {
      try {
        var r = await api('read-snapshot', { folder: folder })
        if (r && r.ok) setViewing({ title: folder + ' - dsh-plugin-snapshot.json', text: JSON.stringify(r.snapshot, null, 2) })
        else setMessage('read failed: ' + (r && r.error))
      } catch (e) {
        setMessage('read failed: ' + String((e && e.message) || e))
      }
    }

    function onFile(ev) {
      var f = ev.target.files && ev.target.files[0]
      if (!f) return
      f.text().then(function (text) {
        return doPreview({ source: 'upload', content: text })
      }).catch(function (err) {
        setMessage('file read failed: ' + String(err))
      })
    }

    var changeRows = preview[0] && preview[0].changes ? preview[0].changes.map(function (c) {
      var isOn = checked[0] === null ? true : !!checked[0][c.name]
      return React.createElement('li', { key: c.name },
        React.createElement('label', { className: 'dshpvm-row' },
          React.createElement('input', {
            type: 'checkbox',
            checked: isOn,
            onChange: function (ev) {
              var cc = {}
              preview[0].changes.forEach(function (x) { cc[x.name] = checked[0] === null ? true : !!checked[0][x.name] })
              cc[c.name] = ev.target.checked
              setChecked(cc)
            },
          }),
          React.createElement('span', null, '[' + c.action + '] ' + c.name + '  ' + (c.to ? '@' + c.to : '') + (c.from ? '  （当前 ' + c.from + '）' : ''))))
    }) : []

    function selectedNames() {
      if (!preview[0] || !preview[0].changes) return []
      return preview[0].changes.filter(function (c) { return checked[0] === null ? true : !!checked[0][c.name] }).map(function (c) { return c.name })
    }

    var pluginRows = (plugins[0] && plugins[0].plugins ? plugins[0].plugins : []).map(function (p, i) {
      return React.createElement('tr', { key: p.name },
        React.createElement('td', null, String(i + 1)),
        React.createElement('td', null, p.name),
        React.createElement('td', null, p.required || '-'),
        React.createElement('td', null, p.installed || '-'))
    })

    var snapshotRows = (snapshots[0] || []).map(function (s) {
      return React.createElement('div', { className: 'dshpvm-row', key: s.folderName },
        React.createElement('span', { style: { flex: 1 } },
          s.folderName,
          s.meta ? React.createElement('span', { className: 'dshpvm-muted' }, '  ' + s.meta.createdAt + ' · ' + s.meta.pluginCount + ' plugins') : null),
        React.createElement('button', { className: 'dshpvm-btn', disabled: busy[0], onClick: function () { return doView(s.folderName) } }, '查看'),
        React.createElement('button', { className: 'dshpvm-btn', disabled: busy[0], onClick: function () { return doPreview({ source: 'folder', folder: s.folderName }) } }, '恢复'))
    })

    return React.createElement('div', { className: 'dshpvm-root' },
      React.createElement('div', { className: 'dshpvm-card' },
        React.createElement('h3', null, '当前已安装插件' + (plugins[0] ? '（' + plugins[0].plugins.length + ' 个 · DSH ' + (plugins[0].dshVersion || '?') + '）' : '')),
        plugins[0] ? React.createElement('div', { className: 'dshpvm-muted' }, 'DSH_HOME: ' + plugins[0].dshHome + ' · 配置目录: ' + plugins[0].profilePath) : null,
        plugins[0] ? React.createElement('table', { className: 'dshpvm-table' },
          React.createElement('thead', null, React.createElement('tr', null,
            React.createElement('th', null, '#'), React.createElement('th', null, '插件名称'), React.createElement('th', null, '要求版本'), React.createElement('th', null, '实际安装'))),
          React.createElement('tbody', null, pluginRows)) : React.createElement('div', { className: 'dshpvm-muted' }, '加载中...'),
        React.createElement('div', { className: 'dshpvm-row' }, React.createElement('button', { className: 'dshpvm-btn', disabled: busy[0], onClick: refresh }, '刷新清单'))),
      React.createElement('div', { className: 'dshpvm-card' },
        React.createElement('h3', null, '版本快照'),
        React.createElement('div', { className: 'dshpvm-row' },
          React.createElement('button', { className: 'dshpvm-btn primary', disabled: busy[0], onClick: doSnapshot }, '生成版本快照'),
          React.createElement('span', { className: 'dshpvm-muted' }, '保存到工作区 dsh-plugin-version-management\\snapshot-<时间>\\（JSON + TXT + 离线恢复脚本）')),
        snapshotRows.length ? React.createElement('div', { style: { marginTop: 6 } }, snapshotRows) : React.createElement('div', { className: 'dshpvm-muted' }, '暂无历史快照')),
      React.createElement('div', { className: 'dshpvm-card' },
        React.createElement('h3', null, '上传快照恢复'),
        React.createElement('div', { className: 'dshpvm-row' },
          React.createElement('input', { type: 'file', accept: '.json,application/json', onChange: onFile, disabled: busy[0] }),
          React.createElement('span', { className: 'dshpvm-muted' }, '选择本地的 dsh-plugin-snapshot.json')),
        preview[0] ? React.createElement('div', null,
          React.createElement('div', { className: 'dshpvm-muted' }, '快照：' + preview[0].folder + '（' + preview[0].snapshotCount + ' 个插件）'),
          React.createElement('ul', { className: 'dshpvm-changes' }, changeRows),
          React.createElement('div', { className: 'dshpvm-row' },
            React.createElement('button', { className: 'dshpvm-btn primary', disabled: busy[0], onClick: function () { return doApply(selectedNames()) } }, '恢复所选'),
            React.createElement('button', { className: 'dshpvm-btn', disabled: busy[0], onClick: function () { return doApply([]) } }, '一键全部恢复'),
            React.createElement('button', { className: 'dshpvm-btn', disabled: busy[0], onClick: function () { setPreview(null) } }, '取消')),
          React.createElement('div', { className: 'dshpvm-muted' }, '恢复会写回 package.json 并运行 pnpm install，完成后请重启 DSH 生效。')) : null),
      status[0] ? React.createElement('div', { className: 'dshpvm-msg' }, '正在恢复（pnpm install 运行中）...') : null,
      message[0] ? React.createElement('div', { className: 'dshpvm-msg' }, message[0]) : null,
      viewing[0] ? React.createElement('div', { className: 'dshpvm-card' },
        React.createElement('h3', null, viewing[0].title),
        React.createElement('div', { className: 'dshpvm-pre' }, viewing[0].text),
        React.createElement('div', { className: 'dshpvm-row' }, React.createElement('button', { className: 'dshpvm-btn', onClick: function () { setViewing(null) } }, '关闭'))) : null)
  }

  exports.apply = function apply(ctx) {
    ctx.effect(function () {
      var styleEl = document.createElement('style')
      styleEl.textContent = CSS
      document.head.appendChild(styleEl)
      return function () {
        if (styleEl.parentNode) styleEl.parentNode.removeChild(styleEl)
      }
    }, 'dsh-plugin-version-management: styles')

    try {
      ctx.slots.inject('plugins.bundle.config', function () {
        return ctx.slots.register(
          { name: 'plugins.bundle.config', key: 'dsh-plugin-version-management' },
          function (props) {
            return React.createElement(VersionPanel, { ctx: ctx })
          }
        )
      })
    } catch (e) {
      console.warn('[dsh-plugin-version-management] bundle.config slot registration failed:', e)
    }

    ctx.slots.inject('settings.section', function () {
      return ctx.slots.register(
        { name: 'settings.section', id: 'dsh-plugin-version-management', order: 65, label: '插件版本恢复' },
        function (props) {
          return React.createElement(VersionPanel, { ctx: ctx })
        })
    })
  }

  exports.name = 'dsh-plugin-version-management'
  exports.inject = ['slots']
  return module.exports
}})