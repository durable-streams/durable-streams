export interface Item {
  name: string
  price: number
}

export interface Order {
  id: string
  items: Array<Item>
}

export function processOrder(order: Order) {
  // validate
  if (!order.id) throw new Error(`missing id`)

  // calculate total
  const total = order.items.reduce((sum, item) => sum + item.price, 0)

  // apply discount
  const discount = 0

  return { total: total - discount, status: `processed` }
}
