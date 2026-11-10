import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { KnowledgeRepository } from '../../src/domainKnowledgeTypes.ts';

export const SUITE_VERSION = 'business-docs-v1';
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const put = (root: string, path: string, content: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); };
const cancel = `import { InventoryClient, PaymentClient, Order } from '../model/contracts.ts';
export class CancellationService {
  constructor(private inventory: InventoryClient, private payments: PaymentClient) {}
  async cancel(order: Order) {
    if (order.state === 'shipped') return { status: 'return_required' };
    if (order.state === 'settled') return { status: 'reversal_required' };
    if (order.state !== 'reserved') return { status: 'not_cancellable' };
    await this.inventory.release(order.reservationId, order.id);
    order.state = 'cancelled';
    return { status: 'cancelled' };
  }
` + Array.from({ length: 404 }, (_, i) => `  // Historical migration slot ${i + 1}; no runtime behavior.\n`).join('') + `  async reverseSettlement(order: Order) {
    if (order.state !== 'settled') return { status: 'not_settled' };
    const response = await this.payments.reverse(order.id, order.amount);
    if (response.status === 'unknown') {
      order.state = 'manual_check';
      return { status: 'manual_check', retryAllowed: false };
    }
    if (response.status !== 'succeeded') return { status: 'reversal_failed' };
    await this.inventory.release(order.reservationId, order.id);
    order.state = 'reversed';
    return { status: 'reversed' };
  }
}
`;
export const SOURCE_FILES: Record<string, Record<string, string>> = {
  'repo-1': {
    'package.json': JSON.stringify({ name: '@fixture/orders', type: 'module', dependencies: { '@fixture/stock': '1.0.0' } }, null, 2),
    'src/model/contracts.ts': `export type Order = { id: string; state: 'reserved'|'settled'|'shipped'|'cancelled'|'manual_check'|'reversed'; reservationId: string; amount: number };
export interface InventoryClient { reserve(orderId: string, quantity: number, expiresAt: number): Promise<string>; release(id: string, key: string): Promise<void> }
export interface PaymentClient { reverse(orderId: string, amount: number): Promise<{status:'succeeded'|'failed'|'unknown'}> }
`,
    'src/api/orders.ts': `import { CancellationService } from '../service/cancellation.ts';
// POST /orders/:id/cancel -> CancellationService.cancel(order)
// POST /orders/:id/reversal -> CancellationService.reverseSettlement(order)
export const routes = ['/orders/:id/cancel', '/orders/:id/reversal'];
export function cancellationRoutes(service: CancellationService) { return service; }
`,
    'src/service/checkout.ts': `import { InventoryClient } from '../model/contracts.ts';
export class CheckoutService {
  constructor(private inventory: InventoryClient) {}
  async place(orderId: string, quantity: number, now: number) {
    if (!Number.isInteger(quantity) || quantity <= 0) throw new Error('invalid_quantity');
    const reservationId = await this.inventory.reserve(orderId, quantity, now + 15 * 60_000);
    return { orderId, reservationId, state: 'reserved' };
  }
}
`,
    'src/service/cancellation.ts': cancel,
    'src/adapters/payment.ts': `// External payment provider: HTTPS POST /v1/reversals with orderId, amount.
// Network timeout is mapped to unknown, not failed; this provider has no idempotent retry guarantee.
export const reversalProtocol = { method: 'POST', path: '/v1/reversals', timeoutMs: 3000 };
`,
  },
  'repo-2': {
    'package.json': JSON.stringify({ name: '@fixture/stock', type: 'module' }, null, 2),
    'src/domain/reservations.ts': `export interface Reservation { id: string; orderId: string; quantity: number; expiresAt: number; state: 'active'|'released' }
export class ReservationService {
  private rows = new Map<string, Reservation>();
  allocated = 0;
  constructor(public stockOnHand: number, public safetyBuffer = 0) {}
  saleable() { return this.stockOnHand - this.allocated - this.safetyBuffer; }
  async reserve(orderId: string, quantity: number, expiresAt: number) {
    if (quantity <= 0 || quantity > this.saleable()) throw new Error('insufficient_stock');
    const id = 'reservation-' + orderId;
    if (this.rows.has(id)) return id;
    this.rows.set(id, { id, orderId, quantity, expiresAt, state: 'active' });
    this.allocated += quantity;
    return id;
  }
  async release(id: string, _key: string) {
    const row = this.rows.get(id);
    if (!row || row.state === 'released') return;
    this.allocated -= row.quantity;
    row.state = 'released';
    // No shipment occurred; stockOnHand is unchanged.
  }
  async expire(now: number) {
    for (const row of this.rows.values()) if (row.state === 'active' && row.expiresAt <= now) await this.release(row.id, row.orderId);
  }
}
`,
    'src/api/reservations.ts': `// POST /reservations -> ReservationService.reserve(orderId, quantity, expiresAt)
// DELETE /reservations/:id -> ReservationService.release(id, orderId)
export const routes = ['/reservations', '/reservations/:id'];
`,
    'src/jobs/housekeeping.ts': `import { ReservationService } from '../domain/reservations.ts';
// Registered by bootstrap; this small entry is part of the business, not a public HTTP API.
export const sweepIntervalMs = 60_000;
export async function sweepExpiredReservations(service: ReservationService, now: number) { await service.expire(now); }
`,
    'src/bootstrap.ts': `import { sweepExpiredReservations, sweepIntervalMs } from './jobs/housekeeping.ts';
import { ReservationService } from './domain/reservations.ts';
export function start(service: ReservationService) { return setInterval(() => void sweepExpiredReservations(service, Date.now()), sweepIntervalMs); }
`,
  },
};
export const MATERIALS = [
  { name: '订单库存业务说明.txt', version: '2026-10-approved', content: `本样例为虚构业务。订单创建后先预留库存，预留有效期十五分钟。取消已预留但未结算的订单仅释放预留，不增加实物库存。已结算订单必须走冲正，不能直接取消；已发货订单转退货流程。支付渠道返回未知结果时必须由财务核对，查明结果前禁止再次提交冲正，以免重复退款。当前产品没有公布退款工作日数；不可猜测。库存的安全保有量不得出售。` },
  { name: '旧规则撤销记录.txt', version: '2026-10-change', content: `历史记录：2026年9月曾建议“渠道超时直接重试一次”，该建议已明确撤销。正式规则以订单库存业务说明 2026-10-approved 为准。撤销原因：本支付渠道不保证幂等，超时可能已发生退款。定时释放到期且仍有效的库存预留属于现行能力，不能因为入口不在 HTTP Controller 而省略。` },
];
export interface SourceFixture { repository: KnowledgeRepository; root: string; revision: string }
export function createFixture(root: string): { sources: SourceFixture[]; digest: string; sourceManifest: unknown } {
  const sources: SourceFixture[] = [];
  for (const [id, files] of Object.entries(SOURCE_FILES)) {
    const directory = join(root, id); mkdirSync(directory, { recursive: true });
    for (const [path, content] of Object.entries(files)) put(directory, path, content);
    const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd: directory, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: '2026-10-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-10-01T00:00:00Z' }, timeout: 10_000 }).trim();
    git('init', '-q', '-b', 'main'); git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Fixed synthetic business sources');
    sources.push({ repository: { id, name: id === 'repo-1' ? 'orders' : 'stock', repository: `https://example.invalid/${id}.git`, branch: 'main', path: '', docs_path: 'docs' }, root: directory, revision: git('rev-parse', 'HEAD') });
  }
  const sourceManifest = Object.fromEntries(Object.entries(SOURCE_FILES).map(([id, files]) => [id, Object.entries(files).map(([path, content]) => ({ path, sha256: hash(content), lines: content.split('\n').length }))]));
  return { sources, digest: hash(JSON.stringify({ version: SUITE_VERSION, files: SOURCE_FILES, materials: MATERIALS })), sourceManifest };
}
export const SMALL_DOCUMENTS = [
  { target_id: 'domain', path: 'domain-docs/domains/order-lifecycle.md' },
  { target_id: 'repo-1', path: 'docs/modules/order-lifecycle/order-lifecycle.md' },
  { target_id: 'repo-2', path: 'docs/modules/inventory-reservations/inventory-reservations.md' },
];
export function instructions(profile: 'small' | 'full') {
  return `本次输入都是虚构的、固定版本的评测源码和上传业务资料。只研究已提供的两个仓，不调用 business_knowledge 或任何外部系统。按所选 Skill 研究真实业务行为，保留条件、异常、未知和历史已撤销事实的区别。图中方法来自源码。用独立只读会话回读源码和文稿评审，发现错误先修改再复核。不要把任务完成或模板齐全当作业务正确。${profile === 'small' ? '\n本次明确缩小文档输出范围，只生成以下三篇，但各篇应完整覆盖它负责的业务：\n' + SMALL_DOCUMENTS.map(d => `${d.target_id}: ${d.path}`).join('\n') + '\n可省略其他索引、AGENTS、接口独立页与规范文档，把必要接口说明放入这三篇。过程规划仍须保存，三篇都完成并评审后才结束。' : '\n按 Skill 正常规划与生成完整文档体系。'}`;
}
