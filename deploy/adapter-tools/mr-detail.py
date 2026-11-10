#!/usr/bin/env python3
"""Read MR identity and the code versions used for delivery analysis."""
import json
import os
import re
import sys
import urllib.parse
import urllib.request


class DetailError(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        raise DetailError('代码平台详情请求发生跳转，请管理员检查平台地址')


try:
    mr_url, token = sys.argv[1:3]
    version_head = sys.argv[3] if len(sys.argv) > 3 else 'current'
    if version_head != 'current' and not re.fullmatch(r'(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})', version_head):
        raise DetailError('MR 比较版本无效')
    mr = urllib.parse.urlsplit(mr_url)
    api = urllib.parse.urlsplit(os.environ.get('MFC_CODEHUB_API', 'https://codehub-y.example.com/api/v4').rstrip('/'))
    if mr.scheme not in ('http', 'https') or mr.netloc != api.netloc or mr.username or mr.password:
        raise DetailError('MR 链接必须属于已配置的代码平台')
    match = re.fullmatch(r'/(.+?)/(?:-/)?merge_requests/([1-9][0-9]*)/?', mr.path)
    if not match:
        raise DetailError('MR 链接格式无效')
    project, iid = match.groups()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def get(path, expected=dict):
        url = urllib.parse.urlunsplit((api.scheme, api.netloc, api.path + path, '', ''))
        request = urllib.request.Request(url, headers={'Private-Token': token})
        with opener.open(request, timeout=4) as response:
            value = json.load(response)
            next_page = response.headers.get('X-Next-Page')
        if not isinstance(value, expected):
            raise DetailError('代码平台详情不是对象')
        return (value, next_page) if expected is list else value

    resource = '/projects/' + urllib.parse.quote(urllib.parse.unquote(project), safe='') + '/merge_requests/' + iid
    detail = get(resource)
    if str(detail.get('iid')) != iid:
        raise DetailError('MR 详情与链接不匹配')
    source_id, target_id = detail.get('source_project_id'), detail.get('target_project_id')
    if not isinstance(source_id, int) or source_id != target_id:
        raise DetailError('目前只支持源分支和目标分支在同一仓库的 MR')
    repo = get('/projects/' + str(source_id))
    if repo.get('id') != source_id or not repo.get('http_url_to_repo'):
        raise DetailError('平台未返回源仓库的 HTTPS 克隆地址')
    diff = detail.get('diff_refs') or {}
    head = detail.get('sha') or diff.get('head_sha')
    # 刚推送时旧 diff 可能还未更新，只用与当前源提交配对的基线。
    base = diff.get('base_sha') if diff.get('head_sha') == head else None
    version = None
    if version_head != 'current':
        # 同一源提交在不同目标版本上可能有不同基线。历史不完整时不猜。
        bases = set()
        for page in range(1, 5):
            rows, next_page = get(resource + '/versions?per_page=100&page=' + str(page), list)
            for row in rows:
                if isinstance(row, dict) and row.get('head_commit_sha') == version_head:
                    bases.add(row.get('base_commit_sha'))
            if len(bases) > 1:
                break
            if next_page == '' or (next_page is None and len(rows) < 100):
                if len(bases) == 1 and None not in bases:
                    version = dict(head=version_head, base=bases.pop())
                break
    print(json.dumps(dict(url=detail.get('web_url'), iid=iid, title=detail.get('title'),
        repo=repo['http_url_to_repo'], source_branch=detail.get('source_branch'),
        target_branch=detail.get('target_branch'), sha=head, base_sha=base, version=version,
        merge_commit_sha=detail.get('merge_commit_sha') or detail.get('squash_commit_sha'), merged_at=detail.get('merged_at'), state=detail.get('state')), ensure_ascii=False))
except Exception as error:
    message = str(error) if isinstance(error, DetailError) else type(error).__name__
    print('MR 详情查询失败: ' + message, file=sys.stderr)
    sys.exit(1)
