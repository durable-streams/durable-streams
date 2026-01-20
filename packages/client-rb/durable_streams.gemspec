# frozen_string_literal: true

require_relative "lib/durable_streams/version"

Gem::Specification.new do |spec|
  spec.name = "durable_streams"
  spec.version = DurableStreams::VERSION
  spec.authors = ["Durable Streams"]
  spec.email = ["hello@electric-sql.com"]

  spec.summary = "Ruby client for Durable Streams protocol"
  spec.description = "A Ruby client library for the Durable Streams protocol - persistent, resumable event streams over HTTP."
  spec.homepage = "https://github.com/durable-streams/durable-streams"
  spec.license = "MIT"
  spec.required_ruby_version = ">= 3.1.0"

  spec.metadata["homepage_uri"] = spec.homepage
  spec.metadata["source_code_uri"] = "https://github.com/durable-streams/durable-streams/tree/main/packages/client-rb"
  spec.metadata["rubygems_mfa_required"] = "true"

  # Specify which files should be added to the gem when it is released.
  # Excludes test harnesses, conformance tooling, and internal docs
  spec.files = Dir.chdir(__dir__) do
    `git ls-files -z`.split("\x0").reject do |f|
      (File.expand_path(f) == __FILE__) ||
        f.start_with?(*%w[bin/ test/ spec/ features/ .git .github appveyor Gemfile]) ||
        f.end_with?(*%w[conformance_adapter.rb run-conformance-adapter.sh design.md])
    end
  end
  spec.bindir = "exe"
  spec.executables = spec.files.grep(%r{\Aexe/}) { |f| File.basename(f) }
  spec.require_paths = ["lib"]

  # Runtime dependencies
  spec.add_dependency "net-http-persistent", "~> 4.0"
end
