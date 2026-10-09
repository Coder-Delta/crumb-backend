const required = ["MONGODB_URI", "JWT_SECRET"];

export function validateEnvironment() {
  const missing = required.filter((name) => !process.env[name]?.trim());
  if (missing.length)
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}.`,
    );
  if (process.env.JWT_SECRET.length < 32)
    throw new Error("JWT_SECRET must contain at least 32 characters.");

  const razorpayValues = ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET"];
  const configuredRazorpayValues = razorpayValues.filter((name) =>
    Boolean(process.env[name]?.trim()),
  );
  if (
    configuredRazorpayValues.length > 0 &&
    configuredRazorpayValues.length !== razorpayValues.length
  ) {
    throw new Error(
      "Set both RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET, or leave both unset to disable online checkout.",
    );
  }
  if (
    configuredRazorpayValues.length === razorpayValues.length &&
    !process.env.RAZORPAY_WEBHOOK_SECRET?.trim()
  ) {
    throw new Error(
      "RAZORPAY_WEBHOOK_SECRET is required when Razorpay API credentials are configured.",
    );
  }
  if (process.env.NODE_ENV === "production") {
    const origins = (process.env.CLIENT_URL || "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean);
    if (
      !origins.length ||
      origins.some((origin) => !origin.startsWith("https://"))
    ) {
      throw new Error(
        "Set CLIENT_URL to the HTTPS origin(s) allowed to access the production API.",
      );
    }
  }
}
