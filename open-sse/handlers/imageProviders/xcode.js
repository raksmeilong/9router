import { IMAGE_SIGNATURES, MAX_IMAGE_BYTES } from "../../config/mediaConfig.js";
import { HTTP_STATUS } from "../../config/runtimeConfig.js";

const XCODE_IMAGE_NODE = Object.freeze({
  prefix: "xcode-image",
  providerIdPrefix: "openai-compatible-",
  apiType: "chat",
  baseUrl: "https://xcode.best/v1",
  model: "gpt-image-2.6-flare",
  maxReferences: 5,
  requestTimeoutMs: 120_000,
});

const PNG = "image/png";
const PNG_DATA_URL_PREFIX = "data:" + PNG + ";base64,";
const PNG_SIGNATURE = Buffer.from(IMAGE_SIGNATURES.find(({ mime }) => mime === PNG).sig);
const MAX_ENCODED_IMAGE_BYTES = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;

function decodeReference(value) {
  if (typeof value !== "string" || !value.startsWith(PNG_DATA_URL_PREFIX) ||
      value.length > PNG_DATA_URL_PREFIX.length + MAX_ENCODED_IMAGE_BYTES) {
    throw new Error("XCode references must be PNG data URLs within the image size limit");
  }
  const encoded = value.slice(PNG_DATA_URL_PREFIX.length);
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error("Invalid XCode reference image data");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length > MAX_IMAGE_BYTES || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error("Invalid XCode reference PNG");
  }
  return new Blob([bytes], { type: PNG });
}

const xcodeImageAdapter = {
  skipAuthRefresh: true,
  fetchOptions: () => ({
    redirect: "error",
    signal: AbortSignal.timeout(XCODE_IMAGE_NODE.requestTimeoutMs),
  }),

  buildUrl: (_model, _credentials, body) => XCODE_IMAGE_NODE.baseUrl +
    (body.images?.length ? "/images/edits" : "/images/generations"),

  buildHeaders: (credentials, requestBody) => {
    const headers = { Authorization: "Bearer " + credentials.apiKey };
    if (!(requestBody instanceof FormData)) headers["Content-Type"] = "application/json";
    return headers;
  },

  buildBody: (model, body) => {
    const references = body.images ?? [];
    if (!Array.isArray(references) || references.length > XCODE_IMAGE_NODE.maxReferences) {
      throw new Error("Invalid number of XCode reference images");
    }
    if (typeof body.prompt !== "string" || !body.prompt.trim()) {
      throw new Error("XCode image requests require a text prompt");
    }
    if (body.output_format !== undefined && body.output_format !== "png") {
      throw new Error("XCode poster output must use PNG");
    }
    const fields = {
      model,
      prompt: body.prompt,
      n: 1,
      output_format: "png",
      response_format: "b64_json",
    };
    for (const field of ["size", "quality"]) {
      if (typeof body[field] === "string" && body[field]) fields[field] = body[field];
    }
    if (references.length === 0) return fields;

    const form = new FormData();
    for (const [field, value] of Object.entries(fields)) form.set(field, String(value));
    const field = references.length === 1 ? "image" : "image[]";
    for (const [index, reference] of references.entries()) {
      form.append(field, decodeReference(reference), "reference-" + (index + 1) + ".png");
    }
    return form;
  },

  parseError(response) {
    void response.body?.cancel().catch(() => {});
    const statusCode = response.status;
    if (statusCode === HTTP_STATUS.UNAUTHORIZED || statusCode === HTTP_STATUS.FORBIDDEN) {
      return { statusCode, message: "XCode declined the image request. Check the XCode credential and quota." };
    }
    if (statusCode === HTTP_STATUS.RATE_LIMITED) {
      return { statusCode, message: "XCode is rate limiting image requests." };
    }
    return { statusCode, message: "XCode could not complete the image request." };
  },

  async parseResponse(response, { onUsage }) {
    const payload = await response.json().catch((error) => {
      if (error.name === "TimeoutError") throw error;
      throw new Error("XCode returned invalid image JSON");
    });
    const image = payload?.data?.[0]?.b64_json;
    if (typeof image !== "string" || !image) {
      throw new Error("XCode returned no base64 image");
    }
    if (payload.usage) {
      onUsage?.({
        ...payload.usage,
        prompt_tokens: payload.usage.prompt_tokens ?? payload.usage.input_tokens,
        completion_tokens: payload.usage.completion_tokens ?? payload.usage.output_tokens,
      });
    }
    return payload;
  },

  normalize: (response) => response,
};

export function getXcodeImageAdapter(provider, model, credentials) {
  const config = credentials?.providerSpecificData;
  const baseUrl = typeof config?.baseUrl === "string" ? config.baseUrl.trim().replace(/\/+$/, "") : "";
  if (typeof provider !== "string" || !provider.startsWith(XCODE_IMAGE_NODE.providerIdPrefix) ||
      model !== XCODE_IMAGE_NODE.model || config?.prefix !== XCODE_IMAGE_NODE.prefix ||
      config.apiType !== XCODE_IMAGE_NODE.apiType || baseUrl !== XCODE_IMAGE_NODE.baseUrl ||
      credentials.authType !== "apikey" || !credentials.apiKey) {
    return null;
  }
  return xcodeImageAdapter;
}
