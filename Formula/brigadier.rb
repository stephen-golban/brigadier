class Brigadier < Formula
  desc "Orchestrate AI coding work from the command-line"
  homepage "https://github.com/stephen-golban/brigadier"
  version "0.0.0"
  license "MIT"

  # Replace these placeholder digests with release digests before publishing
  # the tap. docs/RELEASING.md contains the exact update commands.
  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/stephen-golban/brigadier/releases/download/v0.0.0/brigadier-0.0.0-darwin-arm64.tar.gz"
      sha256 "0000000000000000000000000000000000000000000000000000000000000001"
    else
      url "https://github.com/stephen-golban/brigadier/releases/download/v0.0.0/brigadier-0.0.0-darwin-x64.tar.gz"
      sha256 "0000000000000000000000000000000000000000000000000000000000000002"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/stephen-golban/brigadier/releases/download/v0.0.0/brigadier-0.0.0-linux-arm64.tar.gz"
      sha256 "0000000000000000000000000000000000000000000000000000000000000003"
    else
      url "https://github.com/stephen-golban/brigadier/releases/download/v0.0.0/brigadier-0.0.0-linux-x64.tar.gz"
      sha256 "0000000000000000000000000000000000000000000000000000000000000004"
    end
  end

  def install
    bin.install "brigadier"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/brigadier --version")
  end
end
