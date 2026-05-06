/**
 * Vitest: SecretsScreen.
 *   - lists keys returned by /api/secrets (no values shown anywhere)
 *   - "Add secret" form: key + value (masked) + submit calls PUT
 *   - delete button on each row → confirm → DELETE
 *   - "Add AWS credentials" preset opens a 4-row form with the
 *     canonical aws.* keys
 *   - "Add Azure SP" preset opens a 4-row form with canonical azure.* keys
 *   - empty state when there are no secrets
 *
 * The component depends on web/src/lib/api.ts. We mock api.get/put/delete
 * via vi.mock so the test is fully synchronous (no fetch).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('../../src/lib/api', () => {
  return {
    listSecrets: vi.fn(),
    putSecret: vi.fn(),
    deleteSecret: vi.fn(),
  }
})

import { SecretsScreen } from '../../src/components/screens/SecretsScreen'
import * as api from '../../src/lib/api'

beforeEach(() => {
  vi.resetAllMocks()
  ;(api.listSecrets as any).mockResolvedValue({ secrets: [] })
  ;(api.putSecret as any).mockResolvedValue({ key: 'k', updatedAt: 1 })
  ;(api.deleteSecret as any).mockResolvedValue({ deleted: true })
})

describe('SecretsScreen', () => {
  it('shows the empty state when no secrets exist', async () => {
    render(<SecretsScreen />)
    await waitFor(() => expect(screen.getByTestId('secrets-empty')).toBeVisible())
  })

  it('lists secret keys returned by the API; never shows values', async () => {
    ;(api.listSecrets as any).mockResolvedValue({
      secrets: [
        { key: 'aws.access_key_id', updatedAt: 1700000000000 },
        { key: 'azure.client_id', updatedAt: 1700000001000 },
      ],
    })
    render(<SecretsScreen />)
    await waitFor(() => expect(screen.getByTestId('secrets-row-aws.access_key_id')).toBeVisible())
    expect(screen.getByTestId('secrets-row-azure.client_id')).toBeVisible()
    // Confirm no element ever rendered the value (we never received one)
    expect(screen.queryByText(/AKIA/i)).toBeNull()
  })

  it('Add secret form: type key + value + submit fires putSecret', async () => {
    render(<SecretsScreen />)
    await waitFor(() => expect(screen.getByTestId('secrets-add-key')).toBeVisible())
    fireEvent.change(screen.getByTestId('secrets-add-key'),
      { target: { value: 'custom.api_token' } })
    fireEvent.change(screen.getByTestId('secrets-add-value'),
      { target: { value: 'sk-fake-xxx' } })
    fireEvent.click(screen.getByTestId('secrets-add-submit'))
    await waitFor(() => expect(api.putSecret).toHaveBeenCalledWith('custom.api_token', 'sk-fake-xxx'))
  })

  it('value input is masked (type=password) so it never appears as plain text', async () => {
    render(<SecretsScreen />)
    await waitFor(() => expect(screen.getByTestId('secrets-add-value')).toBeVisible())
    expect(screen.getByTestId('secrets-add-value').getAttribute('type')).toBe('password')
  })

  it('delete row calls deleteSecret(key) and refreshes', async () => {
    ;(api.listSecrets as any).mockResolvedValue({
      secrets: [{ key: 'aws.region', updatedAt: 1 }],
    })
    // The component uses window.confirm to gate the destructive action.
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<SecretsScreen />)
    await waitFor(() => expect(screen.getByTestId('secrets-row-aws.region')).toBeVisible())
    fireEvent.click(screen.getByTestId('secrets-delete-aws.region'))
    await waitFor(() => expect(api.deleteSecret).toHaveBeenCalledWith('aws.region'))
    confirmSpy.mockRestore()
  })

  it('delete row does NOT call deleteSecret when the confirm is cancelled', async () => {
    ;(api.listSecrets as any).mockResolvedValue({
      secrets: [{ key: 'aws.region', updatedAt: 1 }],
    })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<SecretsScreen />)
    await waitFor(() => expect(screen.getByTestId('secrets-row-aws.region')).toBeVisible())
    fireEvent.click(screen.getByTestId('secrets-delete-aws.region'))
    // Give the click handler a chance to run.
    await new Promise((r) => setTimeout(r, 30))
    expect(api.deleteSecret).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
  })

  it('AWS preset reveals 4 input rows with the canonical aws.* keys', async () => {
    render(<SecretsScreen />)
    await waitFor(() => expect(screen.getByTestId('secrets-preset-aws')).toBeVisible())
    fireEvent.click(screen.getByTestId('secrets-preset-aws'))
    expect(screen.getByTestId('secrets-preset-input-aws.access_key_id')).toBeVisible()
    expect(screen.getByTestId('secrets-preset-input-aws.secret_access_key')).toBeVisible()
    expect(screen.getByTestId('secrets-preset-input-aws.session_token')).toBeVisible()
    expect(screen.getByTestId('secrets-preset-input-aws.region')).toBeVisible()
  })

  it('AWS preset submit fires PUT for each non-empty field, skips empty ones', async () => {
    render(<SecretsScreen />)
    await waitFor(() => expect(screen.getByTestId('secrets-preset-aws')).toBeVisible())
    fireEvent.click(screen.getByTestId('secrets-preset-aws'))
    fireEvent.change(screen.getByTestId('secrets-preset-input-aws.access_key_id'),
      { target: { value: 'AKIAFAKEEXAMPLE' } })
    fireEvent.change(screen.getByTestId('secrets-preset-input-aws.secret_access_key'),
      { target: { value: 'sekret' } })
    fireEvent.change(screen.getByTestId('secrets-preset-input-aws.region'),
      { target: { value: 'us-east-1' } })
    // session_token left empty on purpose — should NOT be PUT
    fireEvent.click(screen.getByTestId('secrets-preset-submit'))
    await waitFor(() => expect(api.putSecret).toHaveBeenCalledTimes(3))
    expect(api.putSecret).toHaveBeenCalledWith('aws.access_key_id', 'AKIAFAKEEXAMPLE')
    expect(api.putSecret).toHaveBeenCalledWith('aws.secret_access_key', 'sekret')
    expect(api.putSecret).toHaveBeenCalledWith('aws.region', 'us-east-1')
    expect(api.putSecret).not.toHaveBeenCalledWith('aws.session_token', expect.any(String))
  })

  it('Azure preset reveals 4 input rows with the canonical azure.* keys', async () => {
    render(<SecretsScreen />)
    await waitFor(() => expect(screen.getByTestId('secrets-preset-azure')).toBeVisible())
    fireEvent.click(screen.getByTestId('secrets-preset-azure'))
    expect(screen.getByTestId('secrets-preset-input-azure.client_id')).toBeVisible()
    expect(screen.getByTestId('secrets-preset-input-azure.client_secret')).toBeVisible()
    expect(screen.getByTestId('secrets-preset-input-azure.tenant_id')).toBeVisible()
    expect(screen.getByTestId('secrets-preset-input-azure.subscription_id')).toBeVisible()
  })
})
