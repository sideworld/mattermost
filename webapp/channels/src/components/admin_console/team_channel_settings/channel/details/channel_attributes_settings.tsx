// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import React, {useCallback, useEffect, useState} from 'react';
import {defineMessage, useIntl} from 'react-intl';
import {useDispatch} from 'react-redux';

import type {PropertyField, PropertyFieldOption} from '@mattermost/types/properties';

import {PropertyTypes} from 'mattermost-redux/action_types';
import {Client4} from 'mattermost-redux/client';
import {ACCESS_CONTROL_PROPERTY_GROUP, CHANNEL_OBJECT_TYPE} from 'mattermost-redux/constants/properties';
import {canMoveToOption, getPropertyFieldChangePolicy, getPropertyFieldLabel, isPropertyValueSet} from 'mattermost-redux/utils/property_utils';

import useChannelAttributes from 'components/common/hooks/useChannelAttributes';
import useResolvedChannelAttributes from 'components/common/hooks/useResolvedChannelAttributes';
import AdminPanel from 'components/widgets/admin_console/admin_panel';

import './channel_attributes_settings.scss';

export type PendingChannelAttributeValue = string | string[] | null;

type Props = {
    channelId: string;
    isDisabled?: boolean;
    onChange: (values: Record<string, PendingChannelAttributeValue>) => void;
};

function fieldOptions(field: PropertyField): PropertyFieldOption[] {
    return (field.attrs?.options as PropertyFieldOption[] | undefined) ?? [];
}

/**
 * The bulk-remediation surface for MM-70717: a sysadmin can set every channel
 * attribute's value for this one channel directly, instead of visiting each
 * channel from the notify-admins flow or the missing-values list.
 *
 * Edits are batched under the page's own Save (unlike the Channel Info RHS
 * editor this borrows its rendering rules from, which saves per-field
 * immediately) -- this page already commits every other section's edits
 * together, and these dropdowns should behave the same way.
 */
const ChannelAttributesSettings = ({channelId, isDisabled, onChange}: Props) => {
    const {formatMessage} = useIntl();
    const dispatch = useDispatch();

    const {enabled, loading: fieldsLoading, fields} = useChannelAttributes();

    // Fields are warmed by useChannelAttributes; this channel's own values are
    // not fetched anywhere on this page, so they need their own warm-up here.
    const [valuesLoaded, setValuesLoaded] = useState(false);
    useEffect(() => {
        if (!enabled) {
            return;
        }
        setValuesLoaded(false);
        Client4.getPropertyValues(ACCESS_CONTROL_PROPERTY_GROUP, CHANNEL_OBJECT_TYPE, channelId).then((values) => {
            if (values && values.length > 0) {
                dispatch({
                    type: PropertyTypes.RECEIVED_PROPERTY_VALUES,
                    data: {values},
                });
            }
            setValuesLoaded(true);
        }).catch(() => {
            // Fields still render with "Not set"; a fetch failure here should
            // not hide the whole section.
            setValuesLoaded(true);
        });
    }, [enabled, channelId, dispatch]);

    const attributes = useResolvedChannelAttributes(channelId);

    const [pending, setPending] = useState<Record<string, PendingChannelAttributeValue>>({});

    const handleFieldChange = useCallback((fieldId: string, value: PendingChannelAttributeValue) => {
        setPending((prev) => {
            const next = {...prev, [fieldId]: value};
            onChange(next);
            return next;
        });
    }, [onChange]);

    if (!enabled || (!fieldsLoading && fields.length === 0)) {
        return null;
    }

    return (
        <AdminPanel
            id='channel_attributes_settings'
            title={defineMessage({id: 'admin.channel_settings.channel_detail.attributesTitle', defaultMessage: 'Channel attributes'})}
            subtitle={defineMessage({id: 'admin.channel_settings.channel_detail.attributesDescription', defaultMessage: 'Set this channel\'s value for each channel attribute.'})}
        >
            <div
                className='ChannelAttributesSettings'
                data-testid='channelAttributesSettings'
            >
                {attributes.map(({field, value}) => {
                    const savedRaw = value?.value;
                    const hasValue = isPropertyValueSet(savedRaw);
                    const policy = getPropertyFieldChangePolicy(field);
                    const currentOptionId = typeof savedRaw === 'string' ? savedRaw : undefined;
                    const options = fieldOptions(field);
                    const reachableOptions = options.filter((option) => option.id === currentOptionId || canMoveToOption(field, savedRaw, option.id));
                    const stuck = field.type !== 'text' && hasValue && reachableOptions.every((option) => option.id === currentOptionId);
                    const locked = field.permission_values === 'none' || (hasValue && (policy === 'never' || stuck));
                    const disabled = Boolean(isDisabled) || locked || !valuesLoaded;

                    const rawValue = field.id in pending ? pending[field.id] : (savedRaw ?? null);
                    const label = getPropertyFieldLabel(field);
                    const inputId = `channelAttributesSettings-${field.name}`;

                    let control: React.ReactNode;
                    if (field.type === 'text') {
                        const text = typeof rawValue === 'string' ? rawValue : '';
                        control = (
                            <input
                                id={inputId}
                                type='text'
                                className='ChannelAttributesSettings__input'
                                value={text}
                                disabled={disabled}
                                onChange={(e) => handleFieldChange(field.id, e.target.value || null)}
                                data-testid={inputId}
                            />
                        );
                    } else if (field.type === 'multiselect') {
                        const selected = Array.isArray(rawValue) ? rawValue.filter((id): id is string => typeof id === 'string') : [];
                        control = (
                            <select
                                id={inputId}
                                className='ChannelAttributesSettings__select'
                                multiple={true}
                                disabled={disabled}
                                value={selected}
                                onChange={(e) => {
                                    const next = Array.from(e.target.selectedOptions).map((option) => option.value);
                                    handleFieldChange(field.id, next.length ? next : null);
                                }}
                                data-testid={inputId}
                            >
                                {reachableOptions.map((option) => (
                                    <option
                                        key={option.id}
                                        value={option.id}
                                    >
                                        {option.name}
                                    </option>
                                ))}
                            </select>
                        );
                    } else {
                        const selectedId = typeof rawValue === 'string' ? rawValue : '';
                        control = (
                            <select
                                id={inputId}
                                className='ChannelAttributesSettings__select'
                                disabled={disabled}
                                value={selectedId}
                                onChange={(e) => handleFieldChange(field.id, e.target.value || null)}
                                data-testid={inputId}
                            >
                                <option value=''>
                                    {formatMessage({id: 'admin.channel_settings.channel_detail.attributes.not_set', defaultMessage: 'Not set'})}
                                </option>
                                {reachableOptions.map((option) => (
                                    <option
                                        key={option.id}
                                        value={option.id}
                                    >
                                        {option.name}
                                    </option>
                                ))}
                            </select>
                        );
                    }

                    return (
                        <div
                            className='ChannelAttributesSettings__row'
                            key={field.id}
                            data-testid={`channelAttributesSettingsRow-${field.name}`}
                        >
                            <label htmlFor={inputId}>
                                {label}
                            </label>
                            {control}
                        </div>
                    );
                })}
            </div>
        </AdminPanel>
    );
};

export default ChannelAttributesSettings;
