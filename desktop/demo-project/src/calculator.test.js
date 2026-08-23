import { test, expect } from 'node:test'
import { add, subtract, multiply, divide, pow } from './calculator.js'

test('add function', () => {
  expect(add(2, 3)).toBe(5)
  expect(add(-1, 1)).toBe(0)
  expect(add(0, 0)).toBe(0)
})

test('subtract function', () => {
  expect(subtract(5, 3)).toBe(2)
  expect(subtract(3, 5)).toBe(-2)
  expect(subtract(0, 0)).toBe(0)
})

test('multiply function', () => {
  expect(multiply(3, 4)).toBe(12)
  expect(multiply(-2, 3)).toBe(-6)
  expect(multiply(5, 0)).toBe(0)
})

test('divide function', () => {
  expect(divide(10, 2)).toBe(5)
  expect(divide(5, 2)).toBe(2.5)
  expect(divide(5, 0)).toBe(Infinity)
})

test('pow function', () => {
  expect(pow(2, 3)).toBe(8)
  expect(pow(3, 2)).toBe(9)
  expect(pow(2, 0)).toBe(1)
})
