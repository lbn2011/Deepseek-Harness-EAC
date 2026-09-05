/**
 * GitHub 下载代理与镜像候选链测试（自 main e7c74ff / 0178672 的
 * client-updater-proxy.test.mjs 移植）：
 *   - 代理只为 github.com 资产生效（Gitee / 仿冒域 / 空串直通）；
 *   - 候选序：代理 → 原始 GitHub → 其他源，去重；
 *   - 缓存破坏参数 ?v=&sha256= 只附加到代理地址（代理缓存键随内容变化，
 *     绕开旧安装包缓存）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { githubProxyUrl, downloadUrls } from '../client-updater.js';

const GITHUB_ASSET =
  'https://github.com/zouyuxuan122/Deepseek-Harness-EAC/releases/download/v4.4/Deepseek-Harness-EAC-Setup-x64.exe';
const GITEE_ASSET =
  'https://gitee.com/zouyuxuan122/Deepseek-Harness-EAC/releases/download/v4.4/Deepseek-Harness-EAC-Setup-x64.exe';

test('githubProxyUrl 只代理 GitHub 资产地址', () => {
  assert.equal(githubProxyUrl(GITHUB_ASSET), 'https://gh.geekertao.top/' + GITHUB_ASSET);
  assert.equal(githubProxyUrl(GITEE_ASSET), null);
  assert.equal(githubProxyUrl('https://github.com.evil.example/download.exe'), null);
  assert.equal(githubProxyUrl(''), null);
});

test('downloadUrls 候选序：代理优先，随后原始地址与其他源', () => {
  assert.deepEqual(downloadUrls(GITHUB_ASSET, [GITEE_ASSET]), [
    'https://gh.geekertao.top/' + GITHUB_ASSET,
    GITHUB_ASSET,
    GITEE_ASSET,
  ]);
});

test('downloadUrls 非 GitHub 源保持原样并去重', () => {
  assert.deepEqual(downloadUrls(GITEE_ASSET, [GITEE_ASSET, '']), [GITEE_ASSET]);
});

test('githubProxyUrl 附加 v+sha256 缓存破坏参数', () => {
  assert.equal(
    githubProxyUrl(GITHUB_ASSET, { version: '4.4.1', sha256: 'abc123' }),
    'https://gh.geekertao.top/' + GITHUB_ASSET + '?v=4.4.1&sha256=abc123',
  );
});

test('githubProxyUrl 缺省 sha256 时只附加版本号', () => {
  assert.equal(
    githubProxyUrl(GITHUB_ASSET, { version: '4.4.1' }),
    'https://gh.geekertao.top/' + GITHUB_ASSET + '?v=4.4.1',
  );
});

test('githubProxyUrl 无 opts 时保持纯拼接（向后兼容）', () => {
  assert.equal(githubProxyUrl(GITHUB_ASSET), 'https://gh.geekertao.top/' + GITHUB_ASSET);
});

test('githubProxyUrl 原地址带查询串时用 & 连接', () => {
  assert.equal(
    githubProxyUrl(GITHUB_ASSET + '?foo=1', { version: '4.4.1', sha256: 'abc' }),
    'https://gh.geekertao.top/' + GITHUB_ASSET + '?foo=1&v=4.4.1&sha256=abc',
  );
});

test('githubProxyUrl 对参数值做百分号编码', () => {
  assert.equal(
    githubProxyUrl(GITHUB_ASSET, { version: '4.4.1', sha256: 'a b/c' }),
    'https://gh.geekertao.top/' + GITHUB_ASSET + '?v=4.4.1&sha256=a%20b%2Fc',
  );
});

test('downloadUrls 缓存破坏 opts 只透传给代理地址', () => {
  assert.deepEqual(
    downloadUrls(GITHUB_ASSET, [GITEE_ASSET], { version: '4.4.1', sha256: 'abc' }),
    ['https://gh.geekertao.top/' + GITHUB_ASSET + '?v=4.4.1&sha256=abc', GITHUB_ASSET, GITEE_ASSET],
  );
});
