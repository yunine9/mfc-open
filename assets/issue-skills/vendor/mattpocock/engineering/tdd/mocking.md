# 何时使用 mock

只在**系统边界**上用 mock:

- 外部 API(支付、邮件等)
- 数据库(有时——优先用测试数据库)
- 时间/随机性
- 文件系统(有时)

不要 mock:

- 你自己的类/模块
- 内部协作者
- 凡是你自己能控制的东西

## 为方便 mock 而设计

在系统边界上,把接口设计得容易 mock:

**1. 使用依赖注入**

把外部依赖从外面传进来,而不是在内部自己创建:

```typescript
// Easy to mock
function processPayment(order, paymentClient) {
  return paymentClient.charge(order.total);
}

// Hard to mock
function processPayment(order) {
  const client = new StripeClient(process.env.STRIPE_KEY);
  return client.charge(order.total);
}
```

**2. 优先用 SDK 风格的接口,而不是通用 fetcher**

为每个外部操作写一个具体函数,而不是做一个带条件逻辑的通用函数:

```typescript
// GOOD: Each function is independently mockable
const api = {
  getUser: (id) => fetch(`/users/${id}`),
  getOrders: (userId) => fetch(`/users/${userId}/orders`),
  createOrder: (data) => fetch('/orders', { method: 'POST', body: data }),
};

// BAD: Mocking requires conditional logic inside the mock
const api = {
  fetch: (endpoint, options) => fetch(endpoint, options),
};
```

SDK 风格的做法意味着:
- 每个 mock 只返回一种具体的形状
- 测试的准备工作里没有条件逻辑
- 一眼就能看出测试触达了哪些端点
- 每个端点都有独立的类型安全
