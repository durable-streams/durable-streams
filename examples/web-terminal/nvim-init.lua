-- Basic settings
vim.opt.number = true
vim.opt.relativenumber = true
vim.opt.mouse = 'a'
vim.opt.ignorecase = true
vim.opt.smartcase = true
vim.opt.hlsearch = false
vim.opt.wrap = true
vim.opt.breakindent = true
vim.opt.tabstop = 2
vim.opt.shiftwidth = 2
vim.opt.expandtab = true
vim.opt.termguicolors = true
vim.opt.signcolumn = 'yes'
vim.opt.updatetime = 250
vim.opt.timeoutlen = 300
vim.opt.clipboard = 'unnamedplus'
vim.opt.undofile = true

-- Set leader key
vim.g.mapleader = ' '
vim.g.maplocalleader = ' '

-- Basic keymaps
vim.keymap.set('n', '<Esc>', '<cmd>nohlsearch<CR>')
vim.keymap.set('n', '<leader>q', vim.diagnostic.setloclist)

-- Bootstrap lazy.nvim
local lazypath = vim.fn.stdpath('data') .. '/lazy/lazy.nvim'
if not vim.loop.fs_stat(lazypath) then
  vim.fn.system({
    'git', 'clone', '--filter=blob:none',
    'https://github.com/folke/lazy.nvim.git',
    '--branch=stable', lazypath,
  })
end
vim.opt.rtp:prepend(lazypath)

-- Plugins
require('lazy').setup({
  { 'folke/tokyonight.nvim', priority = 1000, config = function()
    vim.cmd.colorscheme 'tokyonight-night'
  end },
  { 'nvim-treesitter/nvim-treesitter', build = ':TSUpdate', config = function()
    -- Modern treesitter config (0.11+)
    vim.treesitter.language.register('bash', 'sh')
    -- Highlight is now automatic when parsers are installed
  end },
  { 'neovim/nvim-lspconfig' },
  { 'hrsh7th/nvim-cmp', dependencies = { 'hrsh7th/cmp-nvim-lsp' } },
  { 'lewis6991/gitsigns.nvim', config = true },
  { 'nvim-telescope/telescope.nvim', dependencies = { 'nvim-lua/plenary.nvim' } },
  { 'folke/which-key.nvim', config = true },
  { 'echasnovski/mini.nvim', config = function()
    require('mini.statusline').setup()
    require('mini.pairs').setup()
  end },
}, { ui = { border = 'rounded' } })
