# frozen_string_literal: true

module DurableStreams
  # Configuration holds all settings for DurableStreams.
  # Thread-safe when frozen (after configure block completes).
  class Configuration
    attr_accessor :base_url, :default_content_type, :default_headers,
                  :timeout, :retry_policy

    def initialize
      @base_url = nil
      @default_content_type = :json
      @default_headers = {}
      @timeout = 30
      @retry_policy = RetryPolicy.default
    end

    # Deep dup nested mutable objects when copying.
    # Called automatically by dup/clone.
    def initialize_copy(other)
      super
      @default_headers = other.default_headers.dup
      @retry_policy = other.retry_policy.dup if other.retry_policy.respond_to?(:dup) && !other.retry_policy.frozen?
    end
  end
end
