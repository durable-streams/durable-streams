import { createSignal, onCleanup } from "solid-js"

type CollectionLike<TItem> = {
  values(): IterableIterator<TItem>
  toArrayWhenReady(): Promise<unknown>
  subscribeChanges(
    listener: () => void,
    options?: { includeInitialState?: boolean }
  ): { unsubscribe(): void }
}

export function useCollectionData<TItem>(
  collection: CollectionLike<TItem>
): () => Array<TItem> {
  const [data, setData] = createSignal<Array<TItem>>([])
  const sync = () => {
    setData(Array.from(collection.values()))
  }

  const subscription = collection.subscribeChanges(sync, {
    includeInitialState: true,
  })

  void collection.toArrayWhenReady().then(sync)

  onCleanup(() => {
    subscription.unsubscribe()
  })

  return data
}
