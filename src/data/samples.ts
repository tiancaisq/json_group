import { DataDocument } from '../types/editor';

export const SAMPLE_DOCUMENTS: DataDocument[] = [
  {
    id: 'sample-order-json',
    name: 'order_payload.json',
    format: 'json',
    isSample: true,
    updatedAt: Date.now(),
    content: `{
  "orderId": "ORD-20261125-8842",
  "status": "dispatched",
  "currency": "CNY",
  "customer": {
    "id": "CUS-49201",
    "name": "林知远",
    "tier": "enterprise",
    "contact": {
      "email": "zhiyuan.lin@meridian-labs.cn",
      "phone": "+86 138-0013-8421"
    },
    "shippingAddress": {
      "country": "中国",
      "province": "浙江省",
      "city": "杭州市",
      "district": "西湖区",
      "street": "文三路 478 号华星时代广场 A 座 14 层",
      "postalCode": "310012",
      "coordinates": [120.1289, 30.2741]
    }
  },
  "items": [
    {
      "sku": "SEN-PRO-402",
      "title": "高精度温湿度采集模块 (工业级)",
      "quantity": 12,
      "unitPrice": 468.0,
      "specs": {
        "interface": ["RS485", "Modbus-RTU", "MQTT"],
        "operatingRange": {
          "temperature": [-40, 85],
          "humidity": [0, 99.9]
        },
        "calibration": {
          "certified": true,
          "batchCode": "CAL-2026-Q4",
          "tolerance": "±0.15°C (含括号的字符串不会误匹配: { [ )"
        }
      }
    },
    {
      "sku": "GW-EDGE-900",
      "title": "边缘网关控制器",
      "quantity": 2,
      "unitPrice": 2150.0,
      "specs": {
        "ports": ["ETH0", "ETH1", "CAN-FD"],
        "firmware": {
          "channel": "stable",
          "autoRollback": true,
          "checksum": "sha256:9f84b2c1a03e"
        }
      }
    }
  ],
  "billing": {
    "subtotal": 9916.0,
    "shippingFee": 0,
    "taxRate": 0.13,
    "discounts": [
      {
        "code": "BULK-Q4",
        "amount": 500.0,
        "appliesTo": ["SEN-PRO-402"]
      }
    ],
    "total": 9416.0
  },
  "timeline": [
    { "step": "created", "at": "2026-11-25T09:14:00+08:00" },
    { "step": "paid", "at": "2026-11-25T09:15:42+08:00" },
    { "step": "packed", "at": "2026-11-25T11:30:10+08:00" },
    { "step": "dispatched", "at": "2026-11-25T14:05:00+08:00" }
  ]
}`,
  },
  {
    id: 'sample-pipeline-jsonc',
    name: 'pipeline_config.jsonc',
    format: 'jsonc',
    isSample: true,
    updatedAt: Date.now() - 60_000,
    content: `{
  // 数据同步流水线配置（支持注释，注释中的 { [ ( 不会干扰括号匹配）
  "pipeline": "warehouse_realtime_sync",
  "schedule": {
    "mode": "streaming",
    "checkpointIntervalMs": 5000,
    "retryPolicy": {
      "maxAttempts": 5,
      "backoffMs": [500, 1500, 3000, 8000, 15000]
    }
  },
  /*
   * 数据源列表：将光标置于下方任一左括号 [ 或 { 处，
   * 按 Ctrl+M（或 Ctrl+Shift+\\）即可直接跳转至对应右括号。
   */
  "sources": [
    {
      "id": "pg_orders",
      "engine": "postgresql",
      "tables": ["orders", "order_items", "shipments"],
      "filters": {
        "includeSoftDeleted": false,
        "regions": ["cn-east", "cn-south", "ap-southeast"]
      }
    },
    {
      "id": "kafka_events",
      "engine": "kafka",
      "topics": ["clickstream.v2", "inventory.delta"],
      "consumer": {
        "groupId": "analytics-ingest-01",
        "autoOffsetReset": "earliest",
        "batchSize": 1000
      }
    }
  ],
  "transforms": [
    {
      "stage": "normalize_currency",
      "fields": ["subtotal", "total", "unitPrice"],
      "options": {
        "precision": 2,
        "rounding": "HALF_UP"
      }
    },
    {
      "stage": "mask_pii",
      "rules": [
        { "field": "customer.contact.phone", "strategy": "partial_mask" },
        { "field": "customer.contact.email", "strategy": "hash_sha256" }
      ]
    }
  ]
}`,
  },
  {
    id: 'sample-query-expr',
    name: 'query_rules.expr',
    format: 'expression',
    isSample: true,
    updatedAt: Date.now() - 120_000,
    content: `// 多重括号嵌套表达式：同时支持圆括号 ()、方括号 []、花括号 {}
defineRule(
  "high_value_anomaly_check",
  {
    priority: 1,
    scope: ["payments", "settlements"],
    condition: (
      (order.total >= 10000 && !order.customer.verified) ||
      (
        includes(["CNY", "USD", "EUR"], order.currency) &&
        some(order.items, (item) => (
          item.quantity * item.unitPrice > 5000 &&
          !includes(["INTERNAL", "TEST"], item.sku)
        ))
      )
    ),
    actions: [
      notify({
        channel: "risk_ops",
        recipients: ["audit@meridian-labs.cn"],
        payload: {
          orderId: order.orderId,
          tags: ["manual_review", "threshold_exceeded"]
        }
      }),
      holdShipment({
        maxHoldHours: 24,
        fallback: () => releaseOrder(order.orderId)
      })
    ]
  }
)`,
  },
];
