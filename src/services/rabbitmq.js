import amqp from "amqp-connection-manager";
import { applyCapturedPayment, PaymentEventError } from "./paymentEvents.js";

const EVENTS_EXCHANGE = "crumb.payment.events";
const EVENTS_QUEUE = "crumb.payment.webhooks";
const EVENTS_ROUTING_KEY = "razorpay.webhook";
const RETRY_EXCHANGE = "crumb.payment.retry";
const RETRY_QUEUE = "crumb.payment.retry.5s";
const RETRY_ROUTING_KEY = "retry.5s";
const DEAD_EXCHANGE = "crumb.payment.dead";
const DEAD_QUEUE = "crumb.payment.dead-letter";
const DEAD_ROUTING_KEY = "dead";
const MAX_RETRIES = 5;
const PREFETCH = 10;
const PUBLISH_TIMEOUT_MS = 5000;

let connection;
let publisher;
let consumer;
let started = false;

async function assertTopology(channel) {
  await channel.assertExchange(EVENTS_EXCHANGE, "direct", { durable: true });
  await channel.assertExchange(RETRY_EXCHANGE, "direct", { durable: true });
  await channel.assertExchange(DEAD_EXCHANGE, "direct", { durable: true });

  await channel.assertQueue(EVENTS_QUEUE, {
    durable: true,
    deadLetterExchange: DEAD_EXCHANGE,
    deadLetterRoutingKey: DEAD_ROUTING_KEY,
  });
  await channel.bindQueue(EVENTS_QUEUE, EVENTS_EXCHANGE, EVENTS_ROUTING_KEY);

  await channel.assertQueue(RETRY_QUEUE, {
    durable: true,
    messageTtl: 5000,
    deadLetterExchange: EVENTS_EXCHANGE,
    deadLetterRoutingKey: EVENTS_ROUTING_KEY,
  });
  await channel.bindQueue(RETRY_QUEUE, RETRY_EXCHANGE, RETRY_ROUTING_KEY);

  await channel.assertQueue(DEAD_QUEUE, { durable: true });
  await channel.bindQueue(DEAD_QUEUE, DEAD_EXCHANGE, DEAD_ROUTING_KEY);
}

function forwardedProperties(
  message,
  headers = message.properties.headers || {},
) {
  return {
    persistent: true,
    contentType: "application/json",
    messageId: message.properties.messageId,
    timestamp: Date.now(),
    headers,
    timeout: PUBLISH_TIMEOUT_MS,
  };
}

async function forwardToDeadLetter(message, reason) {
  await publisher.publish(
    DEAD_EXCHANGE,
    DEAD_ROUTING_KEY,
    message.content,
    forwardedProperties(message, {
      ...(message.properties.headers || {}),
      "x-crumb-dead-letter-reason": String(reason).slice(0, 180),
    }),
  );
}

async function handleDelivery(channel, message) {
  let event;
  try {
    event = JSON.parse(message.content.toString("utf8"));
  } catch {
    try {
      await forwardToDeadLetter(message, "invalid-json");
      channel.ack(message);
    } catch (error) {
      console.error(
        "RabbitMQ could not dead-letter an invalid event:",
        error.message,
      );
      channel.nack(message, false, true);
    }
    return;
  }

  try {
    const result = await applyCapturedPayment(event);
    if (!result.ignored) {
      console.info("Razorpay payment event applied", {
        eventId: event.eventId,
        orderId: result.orderId,
        duplicate: Boolean(result.duplicate),
      });
    }
    channel.ack(message);
  } catch (error) {
    const retries = Number(
      message.properties.headers?.["x-crumb-retries"] || 0,
    );
    const permanent = error instanceof PaymentEventError && !error.retryable;

    try {
      if (permanent || retries >= MAX_RETRIES) {
        await forwardToDeadLetter(
          message,
          permanent ? error.message : `retry-limit: ${error.message}`,
        );
        console.error("Razorpay event moved to dead-letter queue", {
          eventId: event.eventId,
          error: error.message,
        });
      } else {
        await publisher.publish(
          RETRY_EXCHANGE,
          RETRY_ROUTING_KEY,
          message.content,
          forwardedProperties(message, {
            ...(message.properties.headers || {}),
            "x-crumb-retries": retries + 1,
          }),
        );
      }
      channel.ack(message);
    } catch (publishError) {
      console.error("RabbitMQ could not forward a failed payment event:", {
        eventId: event.eventId,
        error: publishError.message,
      });
      channel.nack(message, false, true);
    }
  }
}

export function startPaymentEventWorker() {
  if (started) return connection;
  started = true;

  const url = process.env.RABBITMQ_URL || "amqp://localhost:5672";
  connection = amqp.connect([url], {
    name: "crumb-payment-events",
    heartbeatIntervalInSeconds: 30,
    reconnectTimeInSeconds: 5,
    maxStoredPubRequests: 1000,
  });
  connection.on("connect", () => console.info("RabbitMQ connected."));
  connection.on("disconnect", ({ err }) =>
    console.error("RabbitMQ disconnected; reconnecting.", err?.message || ""),
  );

  publisher = connection.createChannel({
    name: "crumb-payment-event-publisher",
    confirm: true,
    publishTimeout: PUBLISH_TIMEOUT_MS,
    setup: assertTopology,
  });
  publisher.on("error", (error) =>
    console.error("RabbitMQ publisher channel error:", error.message),
  );

  consumer = connection.createChannel({
    name: "crumb-payment-event-consumer",
    setup: async (channel) => {
      await assertTopology(channel);
      await channel.prefetch(PREFETCH);
      await channel.consume(
        EVENTS_QUEUE,
        (message) => {
          if (message) {
            void handleDelivery(channel, message).catch((error) =>
              console.error(
                "Unexpected payment worker failure:",
                error.message,
              ),
            );
          }
        },
        { noAck: false },
      );
    },
  });
  consumer.on("error", (error) =>
    console.error("RabbitMQ consumer channel error:", error.message),
  );

  return connection;
}

export async function publishRazorpayWebhookEvent(event) {
  if (!publisher) {
    throw Object.assign(new Error("Payment event service is not ready."), {
      status: 503,
    });
  }

  try {
    await publisher.publish(
      EVENTS_EXCHANGE,
      EVENTS_ROUTING_KEY,
      Buffer.from(JSON.stringify(event)),
      {
        persistent: true,
        contentType: "application/json",
        messageId: event.eventId,
        timestamp: Date.now(),
        timeout: PUBLISH_TIMEOUT_MS,
      },
    );
  } catch (error) {
    throw Object.assign(
      new Error("Payment event could not be durably queued. Please retry."),
      { status: 503, cause: error },
    );
  }
}

export async function closePaymentEventWorker() {
  if (!connection) return;
  await Promise.allSettled([publisher?.close(), consumer?.close()]);
  await connection.close();
  connection = undefined;
  publisher = undefined;
  consumer = undefined;
  started = false;
}
