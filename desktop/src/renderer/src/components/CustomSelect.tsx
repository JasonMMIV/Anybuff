import React, { useEffect, useRef, useState } from 'react'
import { ChevronDownIcon } from './Icons'

export interface SelectOption {
  value: string
  label: string
  description?: string
  icon?: React.ReactNode
}

export interface CustomSelectProps {
  value: string
  onChange: (value: string) => void
  options: SelectOption[]
  disabled?: boolean
  placeholder?: string
  icon?: React.ReactNode
  className?: string
  size?: 'small' | 'medium'
  title?: string
  fullWidth?: boolean
  placement?: 'top' | 'bottom' | 'auto'
}

export default function CustomSelect({
  value,
  onChange,
  options,
  disabled = false,
  placeholder = 'Select…',
  icon,
  className = '',
  size = 'medium',
  title,
  fullWidth = false,
  placement = 'auto'
}: CustomSelectProps) {
  const [open, setOpen] = useState(false)
  const [focusedIndex, setFocusedIndex] = useState(-1)
  const [actualPlacement, setActualPlacement] = useState<'top' | 'bottom'>('bottom')
  const containerRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const selectedOption = options.find((o) => o.value === value)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [open])

  useEffect(() => {
    if (open) {
      const idx = options.findIndex((o) => o.value === value)
      setFocusedIndex(idx >= 0 ? idx : 0)

      if (placement === 'top') {
        setActualPlacement('top')
      } else if (placement === 'bottom') {
        setActualPlacement('bottom')
      } else {
        // Auto-detect space
        if (containerRef.current) {
          const rect = containerRef.current.getBoundingClientRect()
          const spaceBelow = window.innerHeight - rect.bottom
          const spaceAbove = rect.top
          if (spaceBelow < 250 && spaceAbove > spaceBelow) {
            setActualPlacement('top')
          } else {
            setActualPlacement('bottom')
          }
        }
      }
    }
  }, [open, value, options, placement])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault()
        setOpen(true)
      }
      return
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setFocusedIndex((prev) => (prev + 1) % options.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setFocusedIndex((prev) => (prev - 1 + options.length) % options.length)
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      if (focusedIndex >= 0 && focusedIndex < options.length) {
        onChange(options[focusedIndex].value)
        setOpen(false)
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
    }
  }

  return (
    <div
      ref={containerRef}
      className={`custom-select-container ${size} ${fullWidth ? 'full-width' : ''} ${className} ${open ? 'is-open' : ''} ${disabled ? 'is-disabled' : ''}`}
      onKeyDown={handleKeyDown}
      title={title}
    >
      <button
        type="button"
        className="custom-select-trigger"
        onClick={() => !disabled && setOpen((prev) => !prev)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {(selectedOption?.icon ?? icon) && (
          <span className="custom-select-icon">{selectedOption?.icon ?? icon}</span>
        )}
        <span className="custom-select-value">
          {selectedOption ? selectedOption.label : <span className="custom-select-placeholder">{placeholder}</span>}
        </span>
        <ChevronDownIcon size={size === 'small' ? 10 : 12} className={`custom-select-chevron ${open ? 'open' : ''}`} />
      </button>

      {open && (
        <div ref={listRef} className={`custom-select-dropdown placement-${actualPlacement}`} role="listbox">
          {options.length === 0 ? (
            <div className="custom-select-empty">{placeholder}</div>
          ) : (
            options.map((opt, i) => {
              const isSelected = opt.value === value
              const isFocused = i === focusedIndex
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={`custom-select-option ${isSelected ? 'selected' : ''} ${isFocused ? 'focused' : ''}`}
                  onClick={() => {
                    onChange(opt.value)
                    setOpen(false)
                  }}
                  onMouseEnter={() => setFocusedIndex(i)}
                >
                  {opt.icon && <span className="custom-select-icon">{opt.icon}</span>}
                  <span className="custom-select-option-label">{opt.label}</span>
                  {opt.description && <span className="custom-select-option-desc">{opt.description}</span>}
                  {isSelected && (
                    <svg
                      className="custom-select-check"
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  )}
                </button>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}
