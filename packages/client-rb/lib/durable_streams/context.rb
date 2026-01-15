# frozen_string_literal: true

module DurableStreams
  # Context holds a frozen configuration snapshot.
  # Use for isolated configurations (e.g., staging vs production).
  #
  # Context is purely a configuration container - no flush/close methods.
  # Stream and Producer handle their own resource management.
  class Context
    attr_reader :config

    # @param parent_config [Configuration] Base configuration to copy from
    # @yield [Configuration] Optional block to customize the copy
    def initialize(parent_config = DurableStreams.configuration)
      @config = parent_config.dup
      yield(@config) if block_given?
      DurableStreams.send(:deep_freeze, @config)
    end

    # Resolve a URL against the configured base_url
    # @param url [String] URL or path
    # @return [String] Full URL
    # @raise [ArgumentError] If URL is blank and no base_url configured
    def resolve_url(url)
      raise ArgumentError, "URL required" if url.nil? || url.to_s.strip.empty?
      return url if url.start_with?("http://", "https://")

      base = @config.base_url&.chomp("/")
      raise ArgumentError, "base_url not configured" unless base

      path = url.start_with?("/") ? url : "/#{url}"
      "#{base}#{path}"
    end
  end
end
