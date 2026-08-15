class Brigadier < Formula
  desc "Orchestrate AI coding work from the command-line"
  homepage "https://github.com/stephen-golban/brigadier"
  version "0.0.0"
  license "MIT"

  # The release workflow replaces this template with the checksums from its
  # built archives. GitHub has not published an archive yet.
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

  def caveats
    <<~EOS
      Run `brigadier init` once to choose which detected hosts brigadier should work inside.
      Restart your AI CLI afterwards.
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/brigadier --version")
  end
end
