# Elixir Streaming SDK Research

This document provides comprehensive research on Elixir SDKs for streaming APIs, documenting key patterns, APIs, and idiomatic approaches.

## Table of Contents

1. [Core Elixir Patterns](#core-elixir-patterns)
   - [GenStage](#genstage)
   - [Broadway](#broadway)
   - [Flow](#flow)
2. [Message Brokers](#message-brokers)
   - [Kafka (brod, kafka_ex, broadway_kafka)](#kafka)
   - [RabbitMQ (broadway_rabbitmq, amqp)](#rabbitmq)
   - [NATS JetStream (gnat)](#nats-jetstream)
   - [Redis Streams (redix, redix_stream)](#redis-streams)
3. [Cloud Platforms](#cloud-platforms)
   - [AWS Kinesis (ex_aws_kinesis)](#aws-kinesis)
   - [Google Cloud Pub/Sub (broadway_cloud_pub_sub, kane)](#google-cloud-pubsub)
   - [Azure Event Hubs](#azure-event-hubs)
4. [Other Platforms](#other-platforms)
   - [Apache Pulsar (pulserl, stargate)](#apache-pulsar)
   - [Redpanda](#redpanda)
   - [Apache Flink](#apache-flink)
5. [HTTP Streaming](#http-streaming)
   - [Mint](#mint)
   - [Finch](#finch)
   - [Req](#req)
6. [OTP Patterns](#otp-patterns)
   - [Supervision](#supervision)
   - [Connection Management](#connection-management)
   - [Reconnection & Backoff](#reconnection--backoff)

---

## Core Elixir Patterns

### GenStage

**Source**: [GenStage HexDocs](https://hexdocs.pm/gen_stage/GenStage.html) | [GitHub](https://github.com/elixir-lang/gen_stage)

GenStage is the foundation for all Elixir streaming abstractions, providing producer-consumer pipelines with backpressure.

#### Three Stage Roles

```elixir
defmodule MyProducer do
  use GenStage

  def init(_), do: {:producer, %{}}

  # Required for producers
  def handle_demand(demand, state) when demand > 0 do
    events = generate_events(demand)
    {:noreply, events, state}
  end
end

defmodule MyProducerConsumer do
  use GenStage

  def init(_), do: {:producer_consumer, %{}}

  # Required for producer_consumers and consumers
  def handle_events(events, _from, state) do
    processed = Enum.map(events, &process/1)
    {:noreply, processed, state}
  end
end

defmodule MyConsumer do
  use GenStage

  def init(_) do
    {:consumer, %{}, subscribe_to: [MyProducer]}
  end

  def handle_events(events, _from, state) do
    Enum.each(events, &IO.inspect/1)
    {:noreply, [], state}
  end
end
```

#### Backpressure Mechanism

Consumers control the velocity by sending demand upstream:

```elixir
# Demand flows upstream (consumer -> producer)
# Events flow downstream (producer -> consumer)

# Consumer requests events via subscription options
{:consumer, state, subscribe_to: [{MyProducer, max_demand: 100, min_demand: 50}]}
```

#### Dispatchers

```elixir
# DemandDispatcher (default) - FIFO to consumer with biggest demand
{:producer, state, dispatcher: GenStage.DemandDispatcher}

# BroadcastDispatcher - all events to all consumers
{:producer, state, dispatcher: GenStage.BroadcastDispatcher}

# PartitionDispatcher - events to partitions based on hash
{:producer, state, dispatcher: {GenStage.PartitionDispatcher, partitions: 4, hash: &hash_fn/1}}
```

#### ConsumerSupervisor

Spawns a child process per event:

```elixir
defmodule MyConsumerSupervisor do
  use ConsumerSupervisor

  def init(_) do
    children = [
      %{id: MyWorker, start: {MyWorker, :start_link, []}, restart: :temporary}
    ]

    ConsumerSupervisor.init(children,
      strategy: :one_for_one,
      subscribe_to: [{MyProducer, max_demand: 50, min_demand: 10}]
    )
  end
end
```

---

### Broadway

**Source**: [Broadway HexDocs](https://hexdocs.pm/broadway/Broadway.html) | [GitHub](https://github.com/dashbitco/broadway) | [elixir-broadway.org](https://elixir-broadway.org/)

Broadway provides concurrent, multi-stage data pipelines with built-in features for production use.

#### Basic Pipeline Structure

```elixir
defmodule MyBroadway do
  use Broadway

  def start_link(_opts) do
    Broadway.start_link(__MODULE__,
      name: __MODULE__,
      producer: [
        module: {BroadwayKafka.Producer, [
          hosts: [localhost: 9092],
          group_id: "my_group",
          topics: ["my_topic"]
        ]},
        concurrency: 1
      ],
      processors: [
        default: [
          concurrency: 10,
          max_demand: 100
        ]
      ],
      batchers: [
        default: [
          batch_size: 100,
          batch_timeout: 200,
          concurrency: 5
        ]
      ]
    )
  end

  # Required callback - process individual messages
  @impl true
  def handle_message(_processor, message, _context) do
    message
    |> Message.update_data(&process_data/1)
    |> Message.put_batcher(:default)
  end

  # Optional callback - process batches
  @impl true
  def handle_batch(:default, messages, _batch_info, _context) do
    # Bulk insert, API calls, etc.
    messages
  end

  # Optional - prepare messages before processing
  @impl true
  def prepare_messages(messages, _context) do
    Enum.map(messages, fn message ->
      Message.update_data(message, &Jason.decode!/1)
    end)
  end
end
```

#### Key Features

| Feature | Description |
|---------|-------------|
| Back-pressure | Built on GenStage, never floods the pipeline |
| Automatic acknowledgements | Messages acked at end of pipeline or on error |
| Batching | Group by size and/or time |
| Fault tolerance | Producers isolated, callbacks stateless |
| Graceful shutdown | Items in flight processed before termination |
| Rate limiting | Control ingestion rate |
| Telemetry | Built-in metrics |
| Partitioning | Preserve ordering per partition |

#### Acknowledgement Configuration

```elixir
# Configure ack behavior per message
message
|> Message.configure_ack(on_success: :ack, on_failure: :noop)

# Or set defaults in producer config
producer: [
  module: {BroadwaySQS.Producer, [
    queue_url: "...",
    on_success: :ack,
    on_failure: :noop
  ]}
]
```

---

### Flow

**Source**: [Flow HexDocs](https://hexdocs.pm/flow/Flow.html)

Flow provides MapReduce-style parallel processing for bounded and unbounded data.

#### Basic Usage

```elixir
# Word count example
File.stream!("large_file.txt")
|> Flow.from_enumerable()
|> Flow.flat_map(&String.split(&1, " "))
|> Flow.partition()
|> Flow.reduce(fn -> %{} end, fn word, acc ->
  Map.update(acc, word, 1, &(&1 + 1))
end)
|> Enum.to_list()
```

#### Partitioning Strategy

```elixir
Flow.from_enumerable(data)
|> Flow.map(&process/1)
# Partition by hash - same key goes to same reducer
|> Flow.partition(key: {:key, :user_id})
|> Flow.reduce(fn -> %{} end, &aggregate/2)
```

#### Windows and Triggers

```elixir
Flow.from_enumerable(events)
|> Flow.partition(window: Flow.Window.periodic(1, :minute))
|> Flow.reduce(fn -> 0 end, fn _event, count -> count + 1 end)
|> Flow.emit(:state)
|> Flow.on_trigger(fn count -> {[count], 0} end)
```

#### Flow vs Broadway

| Aspect | Flow | Broadway |
|--------|------|----------|
| Focus | Data as a whole (aggregations, joins) | Individual events |
| Use case | Batch processing, analytics | Message processing |
| Features | Windows, triggers, MapReduce | Acks, metrics, failure handling |

---

## Message Brokers

### Kafka

#### brod (Erlang/Elixir Client)

**Source**: [brod GitHub](https://github.com/kafka4beam/brod) | [HexDocs](https://hexdocs.pm/brod/)

The most performant Kafka client, written in Erlang.

##### Client Setup

```elixir
# In application.ex
def start(_type, _args) do
  children = [
    %{
      id: :kafka_client,
      start: {:brod, :start_link_client, [
        [{"localhost", 9092}],
        :kafka_client,
        [auto_start_producers: true, default_producer_config: []]
      ]}
    }
  ]
  Supervisor.start_link(children, strategy: :one_for_one)
end
```

##### Producer Pattern

```elixir
defmodule MyProducer do
  def produce(topic, key, value) do
    :brod.produce_sync(:kafka_client, topic, :hash, key, value)
  end

  # Async with callback
  def produce_async(topic, key, value) do
    {:ok, call_ref} = :brod.produce(:kafka_client, topic, :hash, key, value)
    # Handle reply in GenServer's handle_info:
    # {:brod_produce_reply, ^call_ref, :brod_produce_req_acked}
    call_ref
  end
end
```

##### Group Subscriber V2 (Recommended)

```elixir
defmodule MyGroupSubscriber do
  @behaviour :brod_group_subscriber_v2

  def child_spec(opts) do
    config = %{
      client: :kafka_client,
      group_id: "my_consumer_group",
      topics: ["my_topic"],
      cb_module: __MODULE__,
      message_type: :message,  # or :message_set
      consumer_config: [begin_offset: :earliest],
      group_config: [
        offset_commit_policy: :commit_to_kafka_v2,
        offset_commit_interval_seconds: 5,
        rejoin_delay_seconds: 2,
        reconnect_cool_down_seconds: 10
      ]
    }

    %{
      id: __MODULE__,
      start: {:brod, :start_link_group_subscriber_v2, [config]},
      type: :worker,
      restart: :permanent
    }
  end

  @impl true
  def init(_group_id, _init_data) do
    {:ok, %{}}
  end

  @impl true
  def handle_message(message, state) do
    # Process message
    IO.inspect(message, label: "Received")
    {:ok, :commit, state}  # or {:ok, :ack, state} or {:ok, state}
  end
end
```

##### Key Callbacks

| Callback | Purpose |
|----------|---------|
| `init/2` | Initialize subscriber state |
| `handle_message/2` | Process messages, return commit/ack decision |
| `assign_partitions/3` | Custom partition assignment (optional) |
| `get_committed_offset/3` | Custom offset management (optional) |
| `terminate/2` | Cleanup (optional) |

#### kafka_ex

**Source**: [kafka_ex GitHub](https://github.com/kafkaex/kafka_ex) | [HexDocs](https://hexdocs.pm/kafka_ex/)

Pure Elixir Kafka client with simpler API.

```elixir
# Produce
KafkaEx.produce("topic", 0, "message")

# Fetch
KafkaEx.fetch("topic", 0, offset: 5)

# Stream (implements Enumerable)
for message <- KafkaEx.stream("topic", 0) do
  process(message)
end

# GenConsumer pattern
defmodule MyConsumer do
  use KafkaEx.GenConsumer

  def handle_message_set(message_set, state) do
    Enum.each(message_set, &process/1)
    {:async_commit, state}
  end
end
```

#### broadway_kafka

**Source**: [broadway_kafka GitHub](https://github.com/dashbitco/broadway_kafka) | [HexDocs](https://hexdocs.pm/broadway_kafka/)

```elixir
defmodule MyBroadway do
  use Broadway

  def start_link(_opts) do
    Broadway.start_link(__MODULE__,
      name: __MODULE__,
      producer: [
        module: {BroadwayKafka.Producer, [
          hosts: [localhost: 9092],
          group_id: "my_group",
          topics: ["topic1", "topic2"],
          # Authentication
          sasl: {:plain, "user", "password"},
          ssl: true,
          # Performance tuning
          fetch_config: [max_bytes: 1_048_576],
          offset_commit_on_ack: true,
          offset_commit_interval_seconds: 5
        ]},
        concurrency: 1
      ],
      processors: [default: [concurrency: 10]],
      batchers: [default: [batch_size: 100, batch_timeout: 200]]
    )
  end

  def handle_message(_, message, _) do
    # message.metadata contains topic, partition, offset, key, headers
    message
  end
end
```

**Important**: Broadway Kafka preserves partition ordering automatically.

---

### RabbitMQ

#### amqp

**Source**: [amqp GitHub](https://github.com/pma/amqp) | [HexDocs](https://hexdocs.pm/amqp/)

Idiomatic Elixir wrapper for RabbitMQ (AMQP 0.9.1).

```elixir
defmodule RabbitConsumer do
  use GenServer
  use AMQP

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def init(_opts) do
    {:ok, conn} = Connection.open("amqp://guest:guest@localhost")
    {:ok, chan} = Channel.open(conn)

    # Declare queue
    {:ok, _} = Queue.declare(chan, "my_queue", durable: true)

    # Set prefetch for backpressure
    :ok = Basic.qos(chan, prefetch_count: 10)

    # Subscribe
    {:ok, _consumer_tag} = Basic.consume(chan, "my_queue")

    {:ok, %{conn: conn, chan: chan}}
  end

  # Handle incoming messages
  def handle_info({:basic_deliver, payload, %{delivery_tag: tag}}, %{chan: chan} = state) do
    process(payload)
    Basic.ack(chan, tag)
    {:noreply, state}
  end

  def handle_info({:basic_consume_ok, _}, state), do: {:noreply, state}
  def handle_info({:basic_cancel, _}, state), do: {:stop, :normal, state}
end

# Publishing
defmodule RabbitPublisher do
  use AMQP

  def publish(message, routing_key) do
    {:ok, conn} = Connection.open()
    {:ok, chan} = Channel.open(conn)

    Basic.publish(chan, "my_exchange", routing_key, message,
      persistent: true,
      content_type: "application/json"
    )

    Channel.close(chan)
    Connection.close(conn)
  end
end
```

#### broadway_rabbitmq

**Source**: [BroadwayRabbitMQ HexDocs](https://hexdocs.pm/broadway_rabbitmq/)

```elixir
defmodule MyBroadway do
  use Broadway

  def start_link(_opts) do
    Broadway.start_link(__MODULE__,
      name: __MODULE__,
      producer: [
        module: {BroadwayRabbitMQ.Producer, [
          queue: "my_queue",
          connection: [
            host: "localhost",
            username: "guest",
            password: "guest"
          ],
          qos: [prefetch_count: 50],
          on_success: :ack,
          on_failure: :reject
        ]},
        concurrency: 1
      ],
      processors: [default: [concurrency: 10]]
    )
  end

  def handle_message(_, message, _) do
    # message.metadata.amqp_channel available for replies (RPC pattern)
    message
  end
end
```

**Note**: `:prefetch_count` provides backpressure from Broadway to RabbitMQ.

---

### NATS JetStream

**Source**: [gnat GitHub](https://github.com/nats-io/nats.ex) | [jetstream GitHub](https://github.com/mmmries/jetstream) | [HexDocs](https://hexdocs.pm/gnat/)

#### Connection Supervision

```elixir
# In application.ex
children = [
  {Gnat.ConnectionSupervisor, %{
    name: :gnat,
    connection_settings: [
      %{host: "localhost", port: 4222}
    ],
    backoff_period: 4_000  # Reconnection backoff
  }}
]
```

#### Pub/Sub Pattern

```elixir
# Publish
Gnat.pub(:gnat, "subject", "message")

# Subscribe
{:ok, subscription} = Gnat.sub(:gnat, self(), "subject")
receive do
  {:msg, %{body: body, topic: topic}} -> process(body)
end

# Request/Reply
{:ok, %{body: response}} = Gnat.request(:gnat, "subject", "request", receive_timeout: 5_000)
```

#### Consumer Supervisor Pattern

```elixir
defmodule MyConsumer do
  use Gnat.Server

  def request(%{body: body, topic: topic} = msg) do
    # Process and optionally reply
    {:reply, "response"}
  end
end

# In application.ex
children = [
  {Gnat.ConsumerSupervisor, %{
    connection_name: :gnat,
    module: MyConsumer,
    subscription_topics: [
      %{topic: "my.subject", queue_group: "my_group"}
    ]
  }}
]
```

#### JetStream Library

```elixir
# Using the dedicated JetStream library
{:ok, _} = Jetstream.API.Stream.create(:gnat, %Jetstream.API.Stream{
  name: "my_stream",
  subjects: ["events.*"]
})

# Consumer
{:ok, _} = Jetstream.API.Consumer.create(:gnat, "my_stream", %Jetstream.API.Consumer{
  durable_name: "my_consumer",
  ack_policy: :explicit
})
```

---

### Redis Streams

**Source**: [redix GitHub](https://github.com/whatyouhide/redix) | [redix_stream GitHub](https://github.com/hayesgm/redix_stream) | [HexDocs](https://hexdocs.pm/redix_stream/)

#### Basic Redix Usage

```elixir
# Start connection
{:ok, conn} = Redix.start_link(host: "localhost", port: 6379)

# Write to stream
Redix.command(conn, ["XADD", "mystream", "*", "field1", "value1"])

# Read from stream
Redix.command(conn, ["XREAD", "COUNT", "10", "STREAMS", "mystream", "0"])
```

#### Redix.Stream Consumer

```elixir
defmodule MyStreamConsumer do
  use Redix.Stream.Consumer

  def handle_messages(messages) do
    Enum.each(messages, fn message ->
      IO.inspect(message, label: "Processing")
    end)
    :ok
  end
end

# Start consumer
{:ok, _pid} = Redix.Stream.start_link(
  stream: "mystream",
  handler: MyStreamConsumer,
  # Consumer group options
  group_name: "my_group",
  consumer_name: "consumer_1",
  # Behavior options
  create_not_exists: true,
  process_pending: true,
  timeout: 5_000,  # Block wait for messages (0 = forever)
  raise_errors: false
)
```

#### Consumer Groups Pattern

```elixir
# Consumer groups allow multiple consumers to share work
# Each message is delivered to exactly one consumer in the group
Redix.Stream.start_link(
  stream: "orders",
  group_name: "order_processors",
  consumer_name: node() |> to_string(),  # Unique per consumer
  handler: OrderProcessor
)
```

---

## Cloud Platforms

### AWS Kinesis

**Source**: [ex_aws_kinesis GitHub](https://github.com/ex-aws/ex_aws_kinesis) | [HexDocs](https://hexdocs.pm/ex_aws_kinesis/)

#### Setup

```elixir
# mix.exs
def deps do
  [
    {:ex_aws, "~> 2.0"},
    {:ex_aws_kinesis, "~> 2.0"},
    {:hackney, "~> 1.9"},
    {:jason, "~> 1.0"}
  ]
end

# config.exs
config :ex_aws,
  access_key_id: "...",
  secret_access_key: "...",
  region: "us-east-1"
```

#### Producer

```elixir
defmodule KinesisProducer do
  alias ExAws.Kinesis

  def put_record(stream_name, data, partition_key) do
    Kinesis.put_record(stream_name, partition_key, data)
    |> ExAws.request()
  end

  def put_records(stream_name, records) do
    # records = [%{data: "...", partition_key: "..."}, ...]
    Kinesis.put_records(stream_name, records)
    |> ExAws.request()
  end
end
```

#### Consumer with GenServer

```elixir
defmodule KinesisConsumer do
  use GenServer

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def init(opts) do
    stream_name = Keyword.fetch!(opts, :stream_name)
    shard_id = Keyword.fetch!(opts, :shard_id)

    # Get shard iterator
    {:ok, %{"ShardIterator" => iterator}} =
      ExAws.Kinesis.get_shard_iterator(stream_name, shard_id, :trim_horizon)
      |> ExAws.request()

    schedule_poll()
    {:ok, %{stream: stream_name, iterator: iterator}}
  end

  def handle_info(:poll, %{iterator: iterator} = state) do
    {:ok, %{"Records" => records, "NextShardIterator" => next_iterator}} =
      ExAws.Kinesis.get_records(iterator)
      |> ExAws.request()

    Enum.each(records, &process_record/1)

    schedule_poll()
    {:noreply, %{state | iterator: next_iterator}}
  end

  defp schedule_poll, do: Process.send_after(self(), :poll, 1_000)

  defp process_record(%{"Data" => data, "SequenceNumber" => seq}) do
    data |> Base.decode64!() |> Jason.decode!() |> IO.inspect()
  end
end
```

#### Using with Flow

```elixir
# Example from sonic182/elixir_kinesis_flow
defmodule KinesisFlow do
  def process_stream(stream_name) do
    stream_name
    |> get_records_stream()
    |> Flow.from_enumerable()
    |> Flow.map(&decode_record/1)
    |> Flow.partition(key: {:key, :user_id})
    |> Flow.reduce(fn -> %{} end, &aggregate/2)
    |> Enum.to_list()
  end
end
```

---

### Google Cloud Pub/Sub

#### broadway_cloud_pub_sub

**Source**: [broadway_cloud_pub_sub GitHub](https://github.com/dashbitco/broadway_cloud_pub_sub) | [HexDocs](https://hexdocs.pm/broadway_cloud_pub_sub/)

```elixir
# mix.exs
def deps do
  [
    {:broadway_cloud_pub_sub, "~> 0.9.0"},
    {:goth, "~> 1.3"}
  ]
end

# Start Goth for authentication
defmodule MyApp.Application do
  def start(_type, _args) do
    credentials = "path/to/credentials.json" |> File.read!() |> Jason.decode!()

    children = [
      {Goth, name: MyApp.Goth, source: {:service_account, credentials}},
      MyBroadway
    ]

    Supervisor.start_link(children, strategy: :one_for_one)
  end
end

# Broadway pipeline
defmodule MyBroadway do
  use Broadway

  def start_link(_opts) do
    Broadway.start_link(__MODULE__,
      name: __MODULE__,
      producer: [
        module: {BroadwayCloudPubSub.Producer, [
          goth: MyApp.Goth,
          subscription: "projects/my-project/subscriptions/my-subscription",
          receive_interval: 5_000,
          on_success: :ack,
          on_failure: :noop  # or :nack for immediate redelivery
        ]},
        concurrency: 1
      ],
      processors: [default: [concurrency: 10]],
      batchers: [default: [batch_size: 100, batch_timeout: 200]]
    )
  end

  def handle_message(_, message, _) do
    # message.data contains the payload
    # message.metadata contains publish_time, message_id, attributes
    message
  end
end
```

#### Kane (Direct Client)

**Source**: [kane GitHub](https://github.com/peburrows/kane)

```elixir
# Setup with Goth credentials
# Publishing
topic = %Kane.Topic{name: "projects/my-project/topics/my-topic"}
message = %Kane.Message{data: "Hello", attributes: %{"key" => "value"}}
Kane.Message.publish(message, topic)

# Subscribing
subscription = %Kane.Subscription{
  name: "projects/my-project/subscriptions/my-sub",
  topic: topic
}

{:ok, messages, _} = Kane.Subscription.pull(subscription, max_messages: 10)

# Process and acknowledge
Enum.each(messages, &process/1)
Kane.Subscription.ack(subscription, messages)
```

---

### Azure Event Hubs

**No native Elixir client exists.**

Options:
1. **Use Kafka protocol** - Event Hubs supports Kafka protocol
2. **Use AMQP** - Event Hubs supports AMQP 1.0

```elixir
# Via Kafka protocol using brod
:brod.start_link_client(
  [{"your-namespace.servicebus.windows.net", 9093}],
  :event_hub_client,
  [
    ssl: true,
    sasl: {:plain, "$ConnectionString", "your-connection-string"}
  ]
)
```

---

## Other Platforms

### Apache Pulsar

#### pulserl (Erlang Client)

**Source**: [pulserl GitHub](https://github.com/skulup/pulserl) | [HexDocs](https://hexdocs.pm/pulserl/)

```elixir
# Start client
:pulserl.start_link("pulsar://localhost:6650")

# Producer (GenServer per topic/partition)
{:ok, producer} = :pulserl.create_producer("persistent://public/default/my-topic")
:pulserl.sync_produce(producer, "message")

# Consumer
{:ok, consumer} = :pulserl.create_consumer("persistent://public/default/my-topic", [
  subscription_name: "my-sub",
  subscription_type: :shared  # or :exclusive, :failover
])

# Receive loop
receive do
  {:pulserl_message, consumer_id, message} ->
    process(message)
    :pulserl.ack(consumer_id, message)
end
```

#### Stargate (Elixir WebSocket Client)

**Source**: [stargate GitHub](https://github.com/jeffgrunewald/stargate) | [HexDocs](https://hex.pm/packages/stargate)

```elixir
# Producer via WebSocket API
{:ok, producer} = Stargate.Producer.start_link(
  url: "ws://localhost:8080",
  topic: "persistent://public/default/my-topic"
)

Stargate.Producer.push(producer, "message")

# Consumer
{:ok, consumer} = Stargate.Consumer.start_link(
  url: "ws://localhost:8080",
  topic: "persistent://public/default/my-topic",
  subscription: "my-sub",
  handler: MyHandler
)
```

#### PulsarEx (Pure Elixir)

**Source**: [pulsar_ex HexDocs](https://hexdocs.pm/pulsar_ex/)

Pure Elixir implementation using binary protocol.

---

### Redpanda

Redpanda is Kafka-compatible, so use any Kafka client:
- **brod**
- **kafka_ex**
- **broadway_kafka**

```elixir
# Same as Kafka, just different hosts
Broadway.start_link(__MODULE__,
  producer: [
    module: {BroadwayKafka.Producer, [
      hosts: [{"redpanda-host", 9092}],
      group_id: "my_group",
      topics: ["my_topic"]
    ]}
  ]
)
```

---

### Apache Flink

**No native Elixir integration.**

Alternatives:
1. **Espresso** - Elixir stream processing library with Flink-like concepts
2. **Use Kafka/other brokers** as intermediary between Elixir and Flink

#### Espresso

**Source**: [Espresso GitHub](https://github.com/hamidreza-s/Espresso)

```elixir
# Flink-like stream processing in Elixir
Espresso.Source.kafka("topic")
|> Espresso.map(&transform/1)
|> Espresso.filter(&valid?/1)
|> Espresso.aggregate(:count)
|> Espresso.Sink.console()
```

---

## HTTP Streaming

### Mint

**Source**: [Mint GitHub](https://github.com/elixir-mint/mint) | [HexDocs](https://hexdocs.pm/mint/)

Low-level, process-less HTTP client.

```elixir
defmodule StreamingClient do
  def stream_request(url) do
    uri = URI.parse(url)

    {:ok, conn} = Mint.HTTP.connect(
      String.to_atom(uri.scheme),
      uri.host,
      uri.port
    )

    {:ok, conn, request_ref} = Mint.HTTP.request(
      conn,
      "GET",
      uri.path,
      [{"accept", "text/event-stream"}],
      nil
    )

    receive_loop(conn, request_ref, [])
  end

  defp receive_loop(conn, request_ref, acc) do
    receive do
      message ->
        case Mint.HTTP.stream(conn, message) do
          {:ok, conn, responses} ->
            {acc, done?} = handle_responses(responses, request_ref, acc)
            if done?, do: acc, else: receive_loop(conn, request_ref, acc)

          {:error, conn, reason, _responses} ->
            {:error, reason}
        end
    end
  end

  defp handle_responses(responses, ref, acc) do
    Enum.reduce(responses, {acc, false}, fn
      {:status, ^ref, status}, {acc, _} -> {[{:status, status} | acc], false}
      {:headers, ^ref, headers}, {acc, _} -> {[{:headers, headers} | acc], false}
      {:data, ^ref, data}, {acc, _} -> {[{:data, data} | acc], false}
      {:done, ^ref}, {acc, _} -> {acc, true}
    end)
  end
end
```

### Finch

**Source**: [Finch GitHub](https://github.com/sneako/finch) | [HexDocs](https://hexdocs.pm/finch/)

Connection pooling built on Mint.

```elixir
# Start in application.ex
children = [
  {Finch, name: MyFinch}
]

# Basic request
Finch.build(:get, "https://example.com")
|> Finch.request(MyFinch)

# Streaming with callback
Finch.build(:get, "https://example.com/stream")
|> Finch.stream(MyFinch, [], fn
  {:status, status}, acc -> Map.put(acc, :status, status)
  {:headers, headers}, acc -> Map.put(acc, :headers, headers)
  {:data, data}, acc -> Map.update(acc, :data, [data], &[data | &1])
end)

# Stream while (can halt early)
Finch.build(:get, url)
|> Finch.stream_while(MyFinch, [], fn
  {:data, data}, acc when byte_size(data) > 1_000_000 ->
    {:halt, acc}  # Stop streaming
  {:data, data}, acc ->
    {:cont, [data | acc]}
  other, acc ->
    {:cont, acc}
end)
```

**HTTP/2 Note**: Finch uses different strategies for HTTP/1.1 (nimble_pool) vs HTTP/2 (no pooling, multiplexing).

### Req

**Source**: [Req GitHub](https://github.com/wojtekmach/req) | [HexDocs](https://hexdocs.pm/req/)

High-level HTTP client built on Finch.

```elixir
# Basic request
{:ok, resp} = Req.get("https://example.com")

# Streaming with callback
Req.get!(url,
  into: fn {:data, data}, {req, resp} ->
    IO.write(data)
    {:cont, {req, resp}}
  end
)

# Async streaming (messages to calling process)
resp = Req.get!(url, into: :self)

receive do
  {ref, {:data, chunk}} when ref == resp.body.ref ->
    process(chunk)
end

# Parse async messages
case Req.parse_message(resp, message) do
  {:ok, [{:data, chunk}]} -> handle_chunk(chunk)
  {:ok, [:done]} -> :complete
  :unknown -> :not_req_message
end
```

#### SSE Parsing

```elixir
# Server-Sent Events with Req
Req.get!(sse_url,
  into: fn {:data, data}, acc ->
    # Parse SSE format: "data: {...}\n\n"
    data
    |> String.split("\n\n", trim: true)
    |> Enum.each(fn event ->
      case String.trim_leading(event, "data: ") do
        json -> json |> Jason.decode!() |> process_event()
      end
    end)
    {:cont, acc}
  end
)
```

---

## OTP Patterns

### Supervision

#### Standard Supervision Tree

```elixir
defmodule MyApp.Application do
  use Application

  def start(_type, _args) do
    children = [
      # Connection supervisor with backoff
      {Gnat.ConnectionSupervisor, connection_settings()},

      # Broadway pipeline
      MyApp.Broadway,

      # Dynamic consumer supervisor
      {DynamicSupervisor, name: MyApp.ConsumerSupervisor, strategy: :one_for_one}
    ]

    Supervisor.start_link(children, strategy: :one_for_one)
  end
end
```

#### Two-Level Supervision (brod pattern)

```elixir
# brod uses two-level supervision for producers/consumers
#
# TopSupervisor
# ├── ProducersSupervisor
# │   ├── Producer(topic1, partition0)
# │   ├── Producer(topic1, partition1)
# │   └── ...
# └── ConsumersSupervisor
#     ├── Consumer(topic1, partition0)
#     └── ...
```

### Connection Management

#### The `connection` Library Pattern

**Source**: [connection GitHub](https://github.com/elixir-ecto/connection)

```elixir
defmodule MyConnection do
  use Connection

  def start_link(opts) do
    Connection.start_link(__MODULE__, opts)
  end

  def init(opts) do
    {:connect, :init, %{opts: opts, sock: nil}}
  end

  def connect(_info, %{opts: opts} = state) do
    case :gen_tcp.connect(opts[:host], opts[:port], [:binary, active: :once]) do
      {:ok, sock} ->
        {:ok, %{state | sock: sock}}

      {:error, _reason} ->
        # Backoff and retry
        {:backoff, 1_000, state}
    end
  end

  def disconnect(_info, %{sock: sock} = state) do
    :gen_tcp.close(sock)
    {:connect, :reconnect, %{state | sock: nil}}
  end

  def handle_info({:tcp_closed, _}, state) do
    {:disconnect, :tcp_closed, state}
  end

  def handle_info({:tcp_error, _, reason}, state) do
    {:disconnect, {:error, reason}, state}
  end
end
```

#### DBConnection Pattern

```elixir
# DBConnection provides sophisticated pooling with:
# - Connection checkout/checkin
# - Transaction support
# - Automatic reconnection
# - Queue management for overload

{:ok, _} = DBConnection.start_link(MyProtocol, [
  pool_size: 10,
  queue_target: 50,
  queue_interval: 1_000,
  idle_interval: 1_000
])
```

### Reconnection & Backoff

#### Using ElixirRetry

**Source**: [ElixirRetry GitHub](https://github.com/safwank/ElixirRetry)

```elixir
use Retry

# Exponential backoff
retry with: exponential_backoff() |> cap(10_000) |> Stream.take(5) do
  connect_to_broker()
end

# Linear backoff
retry with: linear_backoff(100, 2) |> cap(1_000) |> Stream.take(10) do
  send_message()
end

# Constant backoff
retry with: constant_backoff(500) |> Stream.take(3) do
  api_call()
end
```

#### Using GenRetry

**Source**: [GenRetry GitHub](https://github.com/appcues/gen_retry)

```elixir
# Task-based retry
GenRetry.Task.async(fn ->
  risky_operation()
end, retries: 5, delay: 1_000, exp_base: 2, jitter: 0.1)
|> Task.await()
```

#### Manual Backoff in GenServer

```elixir
defmodule ReconnectingClient do
  use GenServer

  def init(opts) do
    send(self(), :connect)
    {:ok, %{opts: opts, backoff: 1_000, attempts: 0}}
  end

  def handle_info(:connect, state) do
    case do_connect(state.opts) do
      {:ok, conn} ->
        {:noreply, %{state | conn: conn, backoff: 1_000, attempts: 0}}

      {:error, _reason} ->
        # Exponential backoff with cap
        new_backoff = min(state.backoff * 2, 30_000)
        Process.send_after(self(), :connect, state.backoff)
        {:noreply, %{state | backoff: new_backoff, attempts: state.attempts + 1}}
    end
  end
end
```

#### Using :backoff (Erlang Library)

**Source**: [exbackoff GitHub](https://github.com/mingchuno/exbackoff)

```elixir
# Initialize backoff state
backoff = :backoff.init(1_000, 30_000)  # min 1s, max 30s

# On failure, get delay and new state
{delay, new_backoff} = :backoff.fail(backoff)
Process.send_after(self(), :reconnect, delay)

# On success, reset
backoff = :backoff.succeed(backoff)
```

---

## Summary of Patterns

### API Styles by Library Type

| Pattern | Libraries | Use Case |
|---------|-----------|----------|
| **Broadway** | broadway_kafka, broadway_sqs, broadway_rabbitmq, broadway_cloud_pub_sub | Production message processing |
| **GenStage** | Custom pipelines | Fine-grained control |
| **GenServer** | brod, amqp, gnat | Direct broker communication |
| **Behaviour** | brod_group_subscriber_v2 | Kafka consumer groups |
| **Functional** | Mint, Redix | Low-level, process-less |

### Common Configuration Patterns

```elixir
# Typical Broadway configuration
Broadway.start_link(MyBroadway,
  name: MyBroadway,
  producer: [
    module: {Producer, options},
    concurrency: 1  # Usually 1 per topic/queue
  ],
  processors: [
    default: [
      concurrency: System.schedulers_online() * 2,
      max_demand: 100
    ]
  ],
  batchers: [
    default: [
      batch_size: 100,
      batch_timeout: 200,
      concurrency: 5
    ]
  ]
)
```

### Error Handling Strategies

| Strategy | When to Use |
|----------|-------------|
| **Retry with backoff** | Transient failures (network, overload) |
| **Dead letter queue** | Poison messages |
| **Circuit breaker** | Failing dependencies |
| **Supervision restart** | Process crashes |

### Backpressure Approaches

| Library | Mechanism |
|---------|-----------|
| GenStage | Demand-driven (consumers request events) |
| Broadway | Built on GenStage + rate limiters |
| RabbitMQ | Prefetch count |
| Kafka | Consumer lag, pause/resume |
| Finch | Connection pool limits |

---

## References

- [Broadway Documentation](https://hexdocs.pm/broadway/)
- [GenStage Documentation](https://hexdocs.pm/gen_stage/)
- [Flow Documentation](https://hexdocs.pm/flow/)
- [brod Documentation](https://hexdocs.pm/brod/)
- [Concurrent Data Processing in Elixir](https://pragprog.com/titles/sgdpelixir/concurrent-data-processing-in-elixir/) (Book)
- [Handling TCP Connections in Elixir](https://andrealeopardi.com/posts/handling-tcp-connections-in-elixir/)
- [A Breakdown of HTTP Clients in Elixir](https://andrealeopardi.com/posts/breakdown-of-http-clients-in-elixir/)
